import * as vscode from 'vscode';
import { RedHatAuthenticationService, onDidChangeSessions } from './authentication-service';
import { getAuthConfig, getMASAuthConfig } from './common/configuration';
import { getRedHatService, TelemetryService } from "@redhat-developer/vscode-redhat-telemetry";


export async function activate(context: vscode.ExtensionContext) {
	const config = await getAuthConfig();
	const masConfig = await getMASAuthConfig();

	const loginService = await RedHatAuthenticationService.build(context, config);
	const telemetryService: TelemetryService = await (await getRedHatService(context)).getTelemetryService();

	context.subscriptions.push(loginService);

	await loginService.initialize();

	context.subscriptions.push(vscode.authentication.registerAuthenticationProvider(config.serviceId,
		'Red Hat', {
		onDidChangeSessions: onDidChangeSessions.event,
		getSessions: (scopes: string[]) => loginService.getSessions(scopes),
		createSession: async (scopes: string[]) => {
			try {
				const session = await loginService.createSession(scopes.sort().join(' '));
				telemetryService.send({ name: 'account.login' });
				onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
				return session;
			} catch (error) {
				telemetryService.send({ name: 'account.login.failed', properties: { error: `${error}` } });
				throw error;
			}
		},
		removeSession: async (id: string) => {
			try {
				telemetryService.send({ name: 'account.logout' });
				const session = await loginService.removeSession(id);
				if (session) {
					onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
				}
			} catch (error) {
				telemetryService.send({ name: 'account.logout.failed', properties: { error: `${error}` } });
				throw error;
			}
		}
	}
	));

	let masSSOError: string | undefined;

	try {
		const masLoginService = await RedHatAuthenticationService.build(context, masConfig);
		await masLoginService.initialize();
		context.subscriptions.push(masLoginService);
		context.subscriptions.push(vscode.authentication.registerAuthenticationProvider(masConfig.serviceId,
			'Red Hat OpenShift Application Services', {
			onDidChangeSessions: onDidChangeSessions.event,
			getSessions: (scopes: string[]) => masLoginService.getSessions(scopes),
			createSession: async (scopes: string[]) => {
				try {
					telemetryService.send({ name: 'account.login.mas' });
					const session = await masLoginService.createSession(scopes.sort().join(' '));
					onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
					return session;
				} catch (error) {
					telemetryService.send({ name: 'account.login.mas.failed', properties: { error: `${error}` } });
					throw error;
				}
			},
			removeSession: async (id: string) => {
				try {
					telemetryService.send({ name: 'account.logout.mas' });
					const session = await masLoginService.removeSession(id);
					if (session) {
						onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
					}
				} catch (error) {
					telemetryService.send({ name: 'account.logout.mas.failed', properties: { error: `${error}` } });
					throw error;
				}
			}
		}
		));
	} catch (error) {
		console.log(`Error initializing MAS authentication provider: ${error}`);
		vscode.window.showWarningMessage(`Error initializing 'Red Hat OpenShift Application Services' authentication provider. Consider updating the 'Red Hat Authentication' extension.`);
		masSSOError = JSON.stringify(error);
	}

	if (masSSOError) {
		telemetryService.send({
			"name": "startup",
			"properties": {
				"error": masSSOError
			}
		});
	} else {
		telemetryService.sendStartupEvent();
	}

	return;
}