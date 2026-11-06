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

The numerator is canonical USDC held by the LitePSM pocket plus USDC held directly by the LitePSM, read at one Ethereum block. The denominator is **circulating USDS + DAI**, fetched afresh from `https://sky.data.blockanalitica.com/internal/supply/` (`total_circulating`). It is not USDS `totalSupply()` or sUSDS deposits. `SKY_DATA_API_URL` can override the API base on the Slack cron. The components must reconcile and supply must be positive; failed or invalid supply reads stop the check without sending or advancing state. Messages include the supply value and fetch timestamp. The source does not provide an onchain block for its circulation estimate; the USDC balance and supply estimate have separate timestamps.

| USDC reserve / circulating USDS + DAI | Slack message |
| --- | --- |
| `≥ 30%` | No threshold alert; one untagged full-recovery message after a lower band |
| `< 30%` and `≥ 28%` | Downward-crossing message; no mention |
| `< 28%` and `≥ 25%` | Downward-crossing message; no mention |
| `< 25%` and `≥ 20%` | Important threshold; `@here`; SFF internal-reaction callout |
| `< 20%` | 🚨 **ACTION NEEDED**; `@here`; urgent SFF refill callout |

Comparisons use full token precision, with strict below-threshold boundaries and no floating-point decisions. Ratios can cross thresholds because reserves decrease or circulating supply increases. Only the deepest band observed in a check is sent. The cron checks every ten minutes and sends an untagged balance/ratio update every twelve hours. Lower-band messages are not repeated merely because time elapsed; partial recoveries update the observed band quietly, and a later downward recrossing sends again. Recovery to at least 30% sends one untagged message.

The greater-than-10M USDC consecutive-check drop note is retained. It is untagged unless appended to an independently triggered 25% or 20% threshold message. Slack `@here` uses `<!here>`.

The existing SFF wording is retained unless an actual Slack recipient is configured. To directly mention a group, set `SLACK_SFF_MENTION` on `slack-psm-alerts` to `<!subteam^S0123456789>`; for a user, use `<@U0123456789>`. Use a real ID for the intended SFF recipient. The mention is included only at 25% and 20%, alongside `@here`. Keep this variable preserved if importing/updating the Railway infrastructure declaration.

On first startup, the ratio policy creates `slack_ratio_alert_state` separately from the legacy absolute-policy table. It seeds a healthy band with the previous checked balance and last information-message time so the first check reports any active ratio band without inventing an absolute-to-relative recovery. The old table and its accepted bands remain unchanged, so a still-running older worker can complete during rolling deployment. An information-message timestamp remains null until a message is actually delivered. Each new check records its supply denominator. Subsequent restarts preserve the ratio band and do not repeat already-delivered threshold messages.

## Verify safely

After deployment, confirm the `slack-psm-alerts` cron completes successfully every ten minutes and its logs contain `slack_cron_complete`, with no `slack_cron_failed` event. Because a healthy balance intentionally produces no initial message, temporarily lowering production thresholds is not supported. To test the Slack webhook itself without generating a protocol alert, use Slack's webhook setup page or send a clearly labelled test message from a secure terminal, then delete the shell history entry if the URL was entered directly.
