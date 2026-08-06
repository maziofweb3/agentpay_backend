import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { app } from "./app.js";

const PORT = Number(process.env.PORT || 3001);

app.listen(PORT, () => {
  console.log(`[AgentPay API] Express gateway listening on port ${PORT}`);
});
