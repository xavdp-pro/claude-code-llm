const root = __dirname;
module.exports = {
  apps: [
    {
      name: 'helm-v2-litellm',
      cwd: root,
      script: '.venv/bin/litellm',
      args: `--config ${root}/litellm-config.yaml --port 4330 --host 127.0.0.1`,
      interpreter: 'none',
      autorestart: true,
      max_restarts: 20,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'helm-v2-claude-bridge',
      cwd: root,
      script: 'start-bridge.sh',
      interpreter: 'bash',
      autorestart: true,
      max_restarts: 20,
      env: {
        HOME: '/apps/helm-v2',
        PATH: '/apps/helm-v2/.local/bin:/usr/local/bin:/usr/bin:/bin',
        CLAUDE_WS_BASE: '/apps/helm-v2/ws/claude',
      },
    },
  ],
};
