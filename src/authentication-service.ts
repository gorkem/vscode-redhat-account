/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServerResponse } from 'node:http';
import { Client, generators, Issuer, TokenSet } from 'openid-client';
import * as vscode from 'vscode';
import { createServer, startServer } from './authentication-server';
import { AuthConfig } from './common/configuration';
import { Keychain } from './common/keychain';
import Logger from './common/logger';

interface IToken {
	accessToken?: string; // When unable to refresh due to network problems, the access token becomes undefined
	idToken?: string; // depending on the scopes can be either supplied or empty

	expiresIn?: number; // How long access token is valid, in seconds
	expiresAt?: number; // UNIX epoch time at which token will expire
	refreshToken: string;

	account: {
		label: string;
		id: string;
	};
	scope: string;
	sessionId: string;
}

export interface IResolvedToken {
	accessToken: string;
	idToken?: string;
}

interface IStoredSession {
	id: string;
	refreshToken: string;
	scope: string; // Scopes are alphabetized and joined with a space
	account: {
		label?: string;
		displayName?: string,
		id: string
	}
}

export const onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();

export const REFRESH_NETWORK_FAILURE = 'Network failure';

class UriEventHandler extends vscode.EventEmitter<vscode.Uri> implements vscode.UriHandler {
	public handleUri(uri: vscode.Uri) {
		this.fire(uri);
	}
}

export interface RedHatAuthenticationSession extends vscode.AuthenticationSession {
	idToken: string | undefined;
}

export class RedHatAuthenticationService {

	private _tokens: IToken[] = [];
	private _refreshTimeouts: Map<string, NodeJS.Timeout> = new Map<string, NodeJS.Timeout>();
	//private _uriHandler: UriEventHandler;
	private _disposables: vscode.Disposable[] = [];
	private client: Client;
	private keychain: Keychain;
	private context: vscode.ExtensionContext;
	private config: AuthConfig;

	constructor(issuer: Issuer<Client>, context: vscode.ExtensionContext, config: AuthConfig) {
		//this._uriHandler = new UriEventHandler();
		//this._disposables.push(vscode.window.registerUriHandler(this._uriHandler));
		this.config = config;
		this.client = new issuer.Client({
			client_id: config.clientId,
			response_types: ['code'],
			token_endpoint_auth_method: 'none'
		});
		this.context = context;

		this.keychain = new Keychain(config.serviceId, context);
	}

	public static async build(context: vscode.ExtensionContext, config: AuthConfig): Promise<RedHatAuthenticationService> {
		Logger.info(`Configuring ${config.serviceId} {auth: ${config.authUrl}, api: ${config.apiUrl}}`);
		const issuer = await Issuer.discover(config.authUrl);

		const provider = new RedHatAuthenticationService(issuer, context, config);
		return provider;
	}

	public async initialize(): Promise<void> {
		const storedData = await this.keychain.getToken();
		if (storedData) {
			try {
				const sessions = this.parseStoredData(storedData);
				const refreshes = sessions.map(async session => {
					if (!session.refreshToken) {
						return Promise.resolve();
					}

					try {
						await this.refreshToken(session.refreshToken, session.scope, session.id);
					} catch (e: any) {
						if (e.message === REFRESH_NETWORK_FAILURE) {
							const didSucceedOnRetry = await this.handleRefreshNetworkError(session.id, session.refreshToken, session.scope);
							if (!didSucceedOnRetry) {
								this._tokens.push({
									accessToken: undefined,
									refreshToken: session.refreshToken,
									account: {
										label: session.account.label ?? session.account.displayName!,
										id: session.account.id
									},
									scope: session.scope,
									sessionId: session.id
								});
								this.pollForReconnect(session.id, session.refreshToken, session.scope);
							}
						} else {
							await this.removeSession(session.id);
						}
					}
				});

				await Promise.all(refreshes);
			} catch (e) {
				Logger.info('Failed to initialize stored data');
				await this.clearSessions();
			}
		}

		if (this.context.secrets) {
			this._disposables.push(this.context.secrets.onDidChange(() => {
				Logger.info('Secrets changed, checking for token updates');
				this.checkForUpdates();
			}));
		}
	}

	private parseStoredData(data: string): IStoredSession[] {
		return JSON.parse(data);
	}

	private async storeTokenData(): Promise<void> {
		const serializedData: IStoredSession[] = this._tokens.map(token => {
			return {
				id: token.sessionId,
				refreshToken: token.refreshToken,
				scope: token.scope,
				account: token.account
			};
		});

		await this.keychain.setToken(JSON.stringify(serializedData));
	}

	private async checkForUpdates(): Promise<void> {
		const added: vscode.AuthenticationSession[] = [];
		let removed: vscode.AuthenticationSession[] = [];
		const storedData = await this.keychain.getToken();
		if (storedData) {
			try {
				const sessions = this.parseStoredData(storedData);
				let promises = sessions.map(async session => {
					const matchesExisting = this._tokens.some(token => token.scope === session.scope && token.sessionId === session.id);
					if (!matchesExisting && session.refreshToken) {
						try {
							const token = await this.refreshToken(session.refreshToken, session.scope, session.id);
							added.push(this.convertToSessionSync(token));
						} catch (e:any) {
							if (e.message === REFRESH_NETWORK_FAILURE) {
								// Ignore, will automatically retry on next poll.
							} else {
								await this.removeSession(session.id);
							}
						}
					}
				});

				promises = promises.concat(this._tokens.map(async token => {
					const matchesExisting = sessions.some(session => token.scope === session.scope && token.sessionId === session.id);
					if (!matchesExisting) {
						await this.removeSession(token.sessionId);
						removed.push(this.convertToSessionSync(token));
					}
				}));

				await Promise.all(promises);
			} catch (e:any) {
				Logger.error(e.message);
				// if data is improperly formatted, remove all of it and send change event
				removed = this._tokens.map(this.convertToSessionSync);
				this.clearSessions();
			}
		} else {
			if (this._tokens.length) {
				// Log out all, remove all local data
				removed = this._tokens.map(this.convertToSessionSync);
				Logger.info('No stored keychain data, clearing local data');

				this._tokens = [];

				this._refreshTimeouts.forEach(timeout => {
					clearTimeout(timeout);
				});

				this._refreshTimeouts.clear();
			}
		}

		if (added.length || removed.length) {
			onDidChangeSessions.fire({ added: added, removed: removed, changed: [] });
		}
	}

	/**
	 * Return a session object without checking for expiry and potentially refreshing.
	 * @param token The token information.
	 */
	private convertToSessionSync(token: IToken): RedHatAuthenticationSession {
		return {
			id: token.sessionId,
			accessToken: token.accessToken!,
			idToken: token.idToken,
			account: token.account,
			scopes: token.scope.split(' ')
		};
	}

	private async convertToSession(token: IToken): Promise<RedHatAuthenticationSession> {
		const resolvedTokens = await this.resolveAccessAndIdTokens(token);
		return {
			id: token.sessionId,
			accessToken: resolvedTokens.accessToken,
			idToken: resolvedTokens.idToken,
			account: token.account,
			scopes: token.scope.split(' ')
		};
	}

	private async resolveAccessAndIdTokens(token: IToken): Promise<IResolvedToken> {
		if (token.accessToken && (!token.expiresAt || token.expiresAt > Date.now())) {
			token.expiresAt
				? Logger.info(`Token available from cache, expires in ${token.expiresAt - Date.now()} milliseconds`)
				: Logger.info('Token available from cache');
			return Promise.resolve({
				accessToken: token.accessToken,
				idToken: token.idToken
			});
		}

		try {
			Logger.info('Token expired or unavailable, trying refresh');
			const refreshedToken = await this.refreshToken(token.refreshToken, token.scope, token.sessionId);
			if (refreshedToken.accessToken) {
				return {
					accessToken: refreshedToken.accessToken,
					idToken: refreshedToken.idToken
				};
			} else {
				throw new Error();
			}
		} catch (e) {
			throw new Error('Unavailable due to network problems');
		}
	}

	get sessions(): Promise<vscode.AuthenticationSession[]> {
		return Promise.all(this._tokens.map(token => this.convertToSession(token)));
	}

	getSessions(scopes?: string[]): Promise<vscode.AuthenticationSession[]> {
		if (!scopes) {
			return this.sessions;
		}

		const orderedScopes = scopes.sort().join(' ');
		const matchingTokens = this._tokens.filter(token => token.scope === orderedScopes);
		return Promise.all(matchingTokens.map(token => this.convertToSession(token)));
	}


	public async createSession(scopes: string): Promise<vscode.AuthenticationSession> {
		Logger.info(`Logging in ${this.config.authUrl}...`);

		// eslint-disable-next-line no-async-promise-executor
		return new Promise(async (resolve, reject) => {
			const nonce = generators.nonce();
			const { server, redirectPromise, callbackPromise } = createServer(this.config, nonce);

			try {
				const serverBase = this.config.serverConfig.externalUrl;
				const port = await startServer(this.config.serverConfig, server);
				vscode.env.openExternal(vscode.Uri.parse(`${serverBase}:${port}/signin?nonce=${encodeURIComponent(nonce)}`));
				
				const redirectReq = await redirectPromise;
				if ('err' in redirectReq) {
					const { err, res } = redirectReq;
					res.writeHead(302, { Location: `/?service=${this.config.serviceId}&error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
					res.end();
					throw err;
				}

				const host = redirectReq.req.headers.host || '';
				const updatedPortStr = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
				const updatedPort = updatedPortStr ? parseInt(updatedPortStr, 10) : port;

				const redirect_uri = `${serverBase}:${updatedPort}/${this.config.serverConfig.callbackPath}`;
				const code_verifier = generators.codeVerifier();
				const code_challenge = generators.codeChallenge(code_verifier);

				const scope = scopes;

				const authUrl = this.client.authorizationUrl({
					scope: `openid ${scope}`,
					resource: this.config.apiUrl,
					code_challenge,
					code_challenge_method: 'S256',
					redirect_uri: redirect_uri,
					nonce: nonce
				});

				redirectReq.res.writeHead(302, { Location: authUrl });
				redirectReq.res.end();

				const callbackResult = await callbackPromise;

				if ('err' in callbackResult) {
					this.error(callbackResult.res, callbackResult.err);
					throw callbackResult.err;
				}
				let tokenSet: TokenSet;
				try {
					tokenSet = await this.client.callback(redirect_uri, this.client.callbackParams(callbackResult.req), { code_verifier, nonce });
				} catch (error) {
					this.error(callbackResult.res, error);
					throw error;
				}
				
				const token = this.convertToken(tokenSet!, scope);

				callbackResult.res.writeHead(302, { Location: `/?service=${this.config.serviceId}&login=${encodeURIComponent(token.account.label)}` });
				callbackResult.res.end();


				this.setToken(token, scope);
				Logger.info('Login successful');
				const session = await this.convertToSession(token);

				resolve(session);

			} catch (e:any) {
				Logger.error(e.message);
				// If the error was about starting the server, try directly hitting the login endpoint instead
				if (e.message === 'Error listening to server' || e.message === 'Closed' || e.message === 'Timeout waiting for port') {
					//await this.loginWithoutLocalServer(scope);
				}

				reject(e.message);
			} finally {
				setTimeout(() => {
					server.close();
				}, 5000);
			}
		});
	}

	public error(response: ServerResponse, error: any): void {
		response.writeHead(302, { Location: `/?error=${encodeURIComponent(error && error.message || 'Unknown error')}` });
		response.end();
	}

	public dispose(): void {
		this._disposables.forEach(disposable => disposable.dispose());
		this._disposables = [];
	}

	private async setToken(token: IToken, scope: string): Promise<void> {
		const existingTokenIndex = this._tokens.findIndex(t => t.sessionId === token.sessionId);
		if (existingTokenIndex > -1) {
			this._tokens.splice(existingTokenIndex, 1, token);
		} else {
			this._tokens.push(token);
		}

		this.clearSessionTimeout(token.sessionId);

		if (token.expiresIn) {
			this._refreshTimeouts.set(token.sessionId, setTimeout(async () => {
				try {
					const refreshedToken = await this.refreshToken(token.refreshToken, scope, token.sessionId);
					onDidChangeSessions.fire({ added: [], removed: [], changed: [this.convertToSessionSync(refreshedToken)] });
				} catch (e:any) {
					if (e.message === REFRESH_NETWORK_FAILURE) {
						const didSucceedOnRetry = await this.handleRefreshNetworkError(token.sessionId, token.refreshToken, scope);
						if (!didSucceedOnRetry) {
							this.pollForReconnect(token.sessionId, token.refreshToken, token.scope);
						}
					} else {
						await this.removeSession(token.sessionId);
						onDidChangeSessions.fire({ added: [], removed: [this.convertToSessionSync(token)], changed: [] });
					}
				}
			}, 1000 * (token.expiresIn - 30)));
		}

		this.storeTokenData();
	}

	private convertToken(tokenSet: TokenSet, scope: string, existingId?: string): IToken {
		const claims = tokenSet.claims();
		return {
			expiresIn: tokenSet.expires_in,
			expiresAt: tokenSet.expires_in ? Date.now() + tokenSet.expires_in * 1000 : undefined,
			idToken: tokenSet.id_token,
			accessToken: tokenSet.access_token,
			refreshToken: tokenSet.refresh_token!,
			sessionId: existingId || tokenSet.session_state!,
			scope: scope,
			account: {
				id: claims.sub,
				label: claims.preferred_username || claims.email || 'user@example.com'
			}
		};
	}

	private async refreshToken(refreshToken: string, scope: string, sessionId: string): Promise<IToken> {
		Logger.info(`Refreshing token from ${this.config.authUrl}`);
		try {
			const refreshedToken = await this.client.refresh(refreshToken);
			const token = this.convertToken(refreshedToken, scope, sessionId);
			this.setToken(token, scope);
			Logger.info('Token refresh success');
			return token;
		} catch (error) {
			Logger.error(`Refreshing token failed: ${error}`);
			vscode.window.showErrorMessage("You have been signed out because reading stored authentication information failed.");
			throw new Error('Refreshing token failed');
		}
	}

	private clearSessionTimeout(sessionId: string): void {
		const timeout = this._refreshTimeouts.get(sessionId);
		if (timeout) {
			clearTimeout(timeout);
			this._refreshTimeouts.delete(sessionId);
		}
	}

	private removeInMemorySessionData(sessionId: string): IToken | undefined {
		const tokenIndex = this._tokens.findIndex(token => token.sessionId === sessionId);
		let token: IToken | undefined;
		if (tokenIndex > -1) {
			token = this._tokens[tokenIndex];
			this._tokens.splice(tokenIndex, 1);
		}

		this.clearSessionTimeout(sessionId);
		return token;
	}

	private pollForReconnect(sessionId: string, refreshToken: string, scope: string): void {
		this.clearSessionTimeout(sessionId);

		this._refreshTimeouts.set(sessionId, setTimeout(async () => {
			try {
				await this.refreshToken(refreshToken, scope, sessionId);
			} catch (e) {
				this.pollForReconnect(sessionId, refreshToken, scope);
			}
		}, 1000 * 60 * 30));
	}

	private handleRefreshNetworkError(sessionId: string, refreshToken: string, scope: string, attempts = 1): Promise<boolean> {
		return new Promise((resolve, _) => {
			if (attempts === 3) {
				Logger.error('Token refresh failed after 3 attempts');
				return resolve(false);
			}

			if (attempts === 1) {
				const token = this._tokens.find(token => token.sessionId === sessionId);
				if (token) {
					token.accessToken = undefined;
					onDidChangeSessions.fire({ added: [], removed: [], changed: [this.convertToSessionSync(token)] });
				}
			}

			const delayBeforeRetry = 5 * attempts * attempts;

			this.clearSessionTimeout(sessionId);

			this._refreshTimeouts.set(sessionId, setTimeout(async () => {
				try {
					await this.refreshToken(refreshToken, scope, sessionId);
					return resolve(true);
				} catch (e) {
					return resolve(await this.handleRefreshNetworkError(sessionId, refreshToken, scope, attempts + 1));
				}
			}, 1000 * delayBeforeRetry));
		});
	}

	public async removeSession(sessionId: string): Promise<vscode.AuthenticationSession | undefined> {
		Logger.info(`Logging out of session '${sessionId}'`);
		const token = this.removeInMemorySessionData(sessionId);
		let session: vscode.AuthenticationSession | undefined;
		if (token) {
			session = this.convertToSessionSync(token);
		}
		if (this._tokens.length === 0) {
			await this.keychain.deleteToken();
		} else {
			this.storeTokenData();
		}
		return session;
	}

	public async clearSessions() {
		Logger.info('Logging out of all sessions');
		this._tokens = [];
		await this.keychain.deleteToken();

		this._refreshTimeouts.forEach(timeout => {
			clearTimeout(timeout);
		});

		this._refreshTimeouts.clear();
	}
}
