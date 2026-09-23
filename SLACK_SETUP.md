# Slack PSM alert setup

The monitor uses a Slack Incoming Webhook. This is the simplest form of a Slack bot for a single channel: it posts as an installed Slack app, needs no bot token, and does not read messages or workspace data.

## Create the Slack app

1. Open [Slack API: Your Apps](https://api.slack.com/apps) while signed into the target workspace.
2. Select **Create New App**, then **From scratch**.
3. Name it `PSM monitor` and choose the workspace.
4. Open **Incoming Webhooks** and turn **Activate Incoming Webhooks** on.
5. Select **Add New Webhook to Workspace**, choose the alert channel, and approve access.
6. Copy the generated `https://hooks.slack.com/services/...` URL. Treat it as a secret: do not paste it into GitHub, logs, issues, or source files.

The app posts only to the channel selected when the webhook is created. To change channels, create another webhook from the same Slack app. The app name and icon can be adjusted under **Basic Information → Display Information**.

## Configure Railway

Add the webhook URL to the `psm-monitoring` web service as a secret variable:

```text
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

The defaults implement the requested timing:

```text
SLACK_CHECK_INTERVAL_SECONDS=600
SLACK_REMINDER_SECONDS=3600
```

Deploy or restart the web service after adding the secret. Do not add the webhook to the `daily-snapshots` cron service. Alert state is stored in the existing Railway Postgres database, so deployments do not reset the hourly reminder timer.

## Alert policy

The rules use the same Ethereum reading as the dashboard: canonical USDC held by the LitePSM pocket plus USDC held directly by the LitePSM, read at one block.

| Balance | Slack message |
| --- | --- |
| `≥ 3.95B` | No alert; one untagged recovery message after an alert clears |
| `< 3.95B` and `≥ 3.90B` | “Could be refilled”; no mention |
| `< 3.90B` and `≥ 3.85B` | “Should be refilled”; `@here` |
| `< 3.85B` and `≥ 3.80B` | “Should be refilled urgently”; `@here` |
| `< 3.80B` | 🚨 **ACTION NEEDED**; urgent refill; `@here` |

The app evaluates the state every ten minutes, sends immediately when the observed state changes, and repeats the active alert once per hour. Slack mentions use the platform token `<!here>` so the notification actually reaches active channel members.

## Verify safely

After deployment, confirm the service logs contain normal `balance_checked` events and no `slack_alert_failed` event. Because a healthy balance intentionally produces no initial message, temporarily lowering production thresholds is not supported. To test the Slack webhook itself without generating a protocol alert, use Slack's webhook setup page or send a clearly labelled test message from a secure terminal, then delete the shell history entry if the URL was entered directly.
