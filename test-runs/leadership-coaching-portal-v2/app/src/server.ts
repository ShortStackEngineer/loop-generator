import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3457);
const app = createApp();
app.listen(port, () => {
  console.log(`leadership-coaching-portal-v2 listening on :${port}`);
});
