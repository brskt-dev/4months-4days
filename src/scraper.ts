import { performLogin } from "./login";
import { goToReports } from "./reports";
import { fillReport } from "./helpers/fillReport";
import { closeOnboardingPopup } from "./helpers/closePopup";

async function run() {
  const page = await performLogin();
  await closeOnboardingPopup(page);

  // await goToReports(page);
  // await closeOnboardingPopup(page);

  // gerar 10 relatórios
  for (let i = 0; i < 950; i++) {
    await fillReport(page, 9452211);
  }

  console.log("🔥 Finalizado!");
}

run();
