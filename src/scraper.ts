import { performLogin } from "./login";

async function run() {
  const page = await performLogin();

  // TODO: daqui pra frente faremos scraping do dashboard
  console.log("Pronto para scrapear informações...");
}

run();
