// Forwards 127.0.0.1:80 to the Vite app on 5173. Port 80 needs root on macOS;
// dev.sh starts this with sudo so `ngrok http 80` reaches the app.
import net from "node:net";

const server = net.createServer((client) => {
  const upstream = net.connect(5173, "127.0.0.1");
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
});

server.listen({ port: 80, host: "::", ipv6Only: false }, () => {
  console.log("Forwarding port 80 → 127.0.0.1:5173");
});
