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

Those are the only three everyday commands: `pnpm dev`, `ngrok http 80`, and `pnpm stop`.
