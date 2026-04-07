import { Page } from "playwright";
import { TIMEOUTS } from "../constants";

export async function closeOnboardingPopup(page: Page): Promise<void> {
  try {
    await page.waitForSelector("#popupOnboardingStepsOpened", {
      timeout: TIMEOUTS.popup,
    });

    console.log("Popup de onboarding encontrado; escondendo...");

    await page.evaluate(() => {
      const popup = document.querySelector(
        "#popupOnboardingStepsOpened"
      ) as HTMLElement | null;
      if (popup) {
        popup.style.display = "none";
        popup.style.visibility = "hidden";
      }

      const closeButton = document.querySelector(
        "#stepPopupCloseButton"
      ) as HTMLElement | null;
      if (closeButton) {
        closeButton.style.display = "none";
      }
    });
  } catch {
    return;
  }
}
