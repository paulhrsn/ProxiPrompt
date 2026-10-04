# Demo commands

Run these from the project folder:

```sh
cd /Users/paulharrison/Developer/MHACKS/ProxiPrompt
```

## Start the demo

**Terminal 1:**

```sh
pnpm dev
```

Starts the app, database, agent, worker, and port 80 forwarding. Enter your Mac password if prompted. Leave this terminal running.

**Terminal 2:**

```sh
ngrok http 80
```

Open the HTTPS forwarding URL printed by ngrok on every phone. Leave this terminal running too. Your laptop must stay awake and connected to the internet.

## Stop or restart

Stop ngrok with **Ctrl+C in Terminal 2**.

Stop the demo with **Ctrl+C in Terminal 1**, or run:

```sh
pnpm stop
```

To restart, run the two start commands again. After code changes, restart `pnpm dev` so the worker picks up changes, then refresh the app on each device.

## Optional: use the cloud database

Use this instead of `pnpm dev` when you specifically want MainCloud:

```sh
STDB_TARGET=maincloud pnpm dev
```

Still run `ngrok http 80` in Terminal 2. The laptop still hosts the app, agent, and worker. All demo participants must use the same URL and database.

## Phone setup

- Open the ngrok HTTPS URL and choose **Use demo session**.
- For a responder, set the intended location in **You**.
- For background notifications, add the app to your Home Screen, open it from that icon, then select **You → Enable phone notifications → Allow**. Confirm **Notifications enabled**.
- Keep the responder app open during the demo unless you have successfully rehearsed background notifications. Turn off Focus / Do Not Disturb when testing notifications.

## ASI:One chat (the Agentverse agent)

Not a command: the agent starts with `pnpm dev` and connects to Agentverse through its mailbox (`AGENT_MAILBOX=1` in `services/agent/.env`). Nothing extra to run.

1. Open <https://asi1.ai> in a browser tab before the demo and sign in. Turn on **Agents**.
2. Start a chat by addressing the agent's handle:

   ```text
   @proxipromptagent hi
   ```

   If the handle does not resolve, use the full address instead: `@agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs hi`. Last resort: start a chat from the Agentverse profile: <https://agentverse.ai/agents/details/agent1q2n246t50502rk048qful37rqmf3sv9yna6z9gsdlynr3lqrcmzhj7p3ncs/profile>
3. Send, in order: `hi`, `list places`, `Is Shapiro busy right now?`

The third message is a real query, so `pnpm dev` must be running and a responder phone (or `pnpm demo:neighbors`) must be near Shapiro. Expect an answer in about 10 to 15 s. If it takes longer than about 45 s, the agent says "Still working on it" and posts the answer as a follow-up in the same chat.

Those are the only three everyday commands: `pnpm dev`, `ngrok http 80`, and `pnpm stop`.
