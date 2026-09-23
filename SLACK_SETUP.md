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

Apply the Railway configuration after merging the PR. It creates a dedicated `slack-psm-alerts` cron service scheduled with `*/10 * * * *`; the cron references the web service's sealed webhook variable and the existing Postgres database. Do not add the webhook to the `daily-snapshots` cron service. The last observed threshold band, informational-message time, and previous checked balance are stored in Postgres, so deployments do not reset the crossing, twelve-hour, or consecutive-check state.

## Alert policy

The rules use the same Ethereum reading as the dashboard: canonical USDC held by the LitePSM pocket plus USDC held directly by the LitePSM, read at one block.

| Balance | Slack message |
| --- | --- |
| `≥ 4.0B` | No threshold alert; one untagged recovery message after the balance fully recovers |
| `< 4.0B` and `≥ 3.9B` | Downward-crossing message; no mention |
| `< 3.9B` and `≥ 3.8B` | Downward-crossing message; no mention |
| `< 3.8B` and `≥ 3.7B` | Important threshold; `@here`; SFF should be notified for internal reaction |
| `< 3.7B` and `≥ 3.6B` | Restates the 3.8B important message; `@here` again |
| `< 3.6B` and `≥ 3.5B` | Restates the 3.8B important message; `@here` again |
| `< 3.5B` | 🚨 **ACTION NEEDED**; `@here`; SFF should be notified urgently that the PSM should be refilled |

The cron evaluates the state every ten minutes and sends a routine, untagged PSM balance update every twelve hours. A threshold message is sent only when the observed balance crosses into a lower band; it is not repeated merely because time elapsed. If the balance moves up without reaching 4.0B, no threshold message is sent, but a later downward crossing alerts again. A full recovery to at least 4.0B sends one untagged recovery message. The cron also sends an untagged informational note when the balance decreases by more than 10M USDC between consecutive checks. If that drop coincides with a threshold crossing, the note is appended to the threshold message; any `@here` in that combined message comes from the threshold rule, not the drop rule. Slack mentions use the platform token `<!here>` so the notification actually reaches active channel members.

## Verify safely

After deployment, confirm the `slack-psm-alerts` cron completes successfully every ten minutes and its logs contain `slack_cron_complete`, with no `slack_cron_failed` event. Because a healthy balance intentionally produces no initial message, temporarily lowering production thresholds is not supported. To test the Slack webhook itself without generating a protocol alert, use Slack's webhook setup page or send a clearly labelled test message from a secure terminal, then delete the shell history entry if the URL was entered directly.
