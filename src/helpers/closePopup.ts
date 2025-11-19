import { Page } from "playwright";

/**
 * Esconde o popup de onboarding do Produttivo que abre automaticamente.
 * Pode ser chamado sempre após qualquer navegação.
 */
export async function closeOnboardingPopup(page: Page): Promise<void> {
  try {
    // aguarda o popup existir no DOM (não bloqueia se ele não estiver)
    await page.waitForSelector("#popupOnboardingStepsOpened", {
      timeout: 2000,
    });

    console.log("🧹 Popup de onboarding encontrado — escondendo...");

    await page.evaluate(() => {
      const popup = document.querySelector(
        "#popupOnboardingStepsOpened"
      ) as HTMLElement;
      if (popup) {
        popup.style.display = "none";
        popup.style.visibility = "hidden";
      }

      const closeBtn = document.querySelector(
        "#stepPopupCloseButton"
      ) as HTMLElement;
      if (closeBtn) closeBtn.style.display = "none";
    });
  } catch {
    // popup não apareceu — segue o jogo
  }
}
