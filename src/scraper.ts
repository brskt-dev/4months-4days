import { performLogin, safeSessionReset } from "./login";
import {
  goToReports,
  applyDateFilter,
  extractTotalReports,
  downloadReportsFromPage,
} from "./reports";
import { fillReport } from "./helpers/fillReport";
import { closeOnboardingPopup } from "./helpers/closePopup";

async function run() {
  console.log("🚀 Iniciando extração de relatórios...");

  let page = await performLogin();
  await closeOnboardingPopup(page);

  await goToReports(page);
  await applyDateFilter(page);
  await closeOnboardingPopup(page);

  const { totalReports, reportsPerPage, totalPages } =
    await extractTotalReports(page);

  console.log(`\n📊 Estatísticas`);
  console.log(`📌 Total de relatórios: ${totalReports}`);
  console.log(`📌 Relatórios por página: ${reportsPerPage}`);
  console.log(`📌 Total de páginas: ${totalPages}`);

  let downloaded = 0;

  for (let pageIndex = 1; pageIndex <= totalPages; pageIndex++) {
    console.log(`\n-----------------------------`);
    console.log(`📄 PROCESSANDO PÁGINA ${pageIndex}/${totalPages}`);
    console.log(`-----------------------------`);

    // navegar para página correta caso não esteja na primeira
    if (pageIndex > 1) {
      await page.goto(
        `https://app.produttivo.com.br/form_fills?page=${pageIndex}`
      );
      await closeOnboardingPopup(page);
    }

    const success = await downloadReportsFromPage(page, pageIndex);
    downloaded += success;

    console.log(`📥 Total baixado até agora: ${downloaded}/${totalReports}`);

    // A cada 100, reset
    if (downloaded > 0 && downloaded % 100 === 0) {
      page = await safeSessionReset(page, pageIndex + 1);
    }
  }

  console.log("\n🎉 Extração concluída com sucesso!");
}

run();
