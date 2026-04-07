import { Page } from "playwright";

export async function closeOnboardingPopup(page: Page): Promise<void> {
  try {
    const popup = page.locator("#popupOnboardingStepsOpened").first();
    if ((await popup.count()) === 0) {
      return;
    }

    const isVisible = await popup.isVisible().catch(() => false);
    if (!isVisible) {
      return;
    }

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
