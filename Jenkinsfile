#!/usr/bin/env groovy

def installBuildRequirements(){
    def nodeHome = tool 'nodejs-14.19.1'
    env.PATH="${env.PATH}:${nodeHome}/bin"
    sh "npm install -g typescript vsce"
}

def isCanonicalRepo() {
    "main".equals(params.BRANCH) && "redhat-developer".equals(params.FORK)
}

node('rhel8'){

    stage 'Checkout vscode-redhat-account'
    deleteDir()
    git url: "https://github.com/${params.FORK}/vscode-redhat-account.git", branch: params.BRANCH

    stage 'install vscode-redhat-account build requirements'
    installBuildRequirements()

    stage 'Build vscode-redhat-account'
    sh "npm ci"
    sh "npm run vscode:prepublish"

    // stage 'Test vscode-redhat-account for staging'
    // wrap([$class: 'Xvnc']) {
    //  sh "npm run test-compile"
    //  sh "npm test --silent"
    // }

    stage "Package vscode-redhat-account"
    def packageJson = readJSON file: 'package.json'
    sh "vsce package -o vscode-redhat-account-${packageJson.version}-${env.BUILD_NUMBER}.vsix"
    sh "sha256sum *.vsix > vscode-redhat-account-${packageJson.version}-${env.BUILD_NUMBER}.vsix.sha256"

    if (params.UPLOAD_LOCATION && isCanonicalRepo()) {
        stage 'Upload vscode-redhat-account to staging'
        def vsix = findFiles(glob: '**.vsix*')
        sh "rsync -Pzrlt --rsh=ssh --protocol=28 ${vsix[0].path} ${UPLOAD_LOCATION}/snapshots/vscode-redhat-account/"
        stash name:'vsix', includes:vsix[0].path
    }
}

node('rhel8'){
    if(publishToMarketPlace.equals('true') && isCanonicalRepo()){
    timeout(time:5, unit:'DAYS') {
        input message:'Approve deployment?', submitter: 'fbricon'
    }

    stage "Publish to Marketplaces"
    unstash 'vsix';
    def vsix = findFiles(glob: '**.vsix*')
    // VS Code Marketplace
    withCredentials([[$class: 'StringBinding', credentialsId: 'vscode_java_marketplace', variable: 'TOKEN']]) {
        sh 'vsce publish -p ${TOKEN} --packagePath' + " ${vsix[0].path}"
    }

    // Open-vsx Marketplace
    sh "npm install -g ovsx"
    withCredentials([[$class: 'StringBinding', credentialsId: 'open-vsx-access-token', variable: 'OVSX_TOKEN']]) {
        sh 'ovsx publish -p ${OVSX_TOKEN}' + " ${vsix[0].path}"
    }
    archive includes:"**.vsix"

    if (params.UPLOAD_LOCATION) {
      stage "Promote build to stable/ directory"
      sh "rsync -Pzrlt --rsh=ssh --protocol=28 *.vsix* ${UPLOAD_LOCATION}/stable/vscode-redhat-account/"
    }
  }
}