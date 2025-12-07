import { performLogin, safeSessionReset } from "./login";
import {
  goToReports,
  applyFilters,
  extractFormTypes,
  extractTotalReports,
  downloadReportsFromPage,
} from "./reports";
import { fillReport } from "./helpers/fillReport";
import { closeOnboardingPopup } from "./helpers/closePopup";

async function run() {
  console.log("🚀 Iniciando extração...");

  let page = await performLogin();
  await closeOnboardingPopup(page);

  await goToReports(page);
  await closeOnboardingPopup(page);

  // 1️⃣ extrair tipos de formulários válidos
  const forms = await extractFormTypes(page);

  if (forms.length === 0) {
    console.log("❌ Nenhum formulário encontrado.");
    return;
  }

  for (const form of forms) {
    console.log("\n====================================");
    console.log(`📘 Extraindo do formulário: ${form.name} (${form.id})`);
    console.log("====================================");

    await applyFilters(page, {
      formId: form.id,
      startDate: "01/01/2000",
      endDate: "31/12/2025",
    });

    await closeOnboardingPopup(page);

    const { totalReports, totalPages } = await extractTotalReports(page);

    console.log(`📊 Total: ${totalReports} relatórios (${totalPages} páginas)`);

    for (let pageIndex = 1; pageIndex <= totalPages; pageIndex++) {
      await page.goto(
        `https://app.produttivo.com.br/form_fills?page=${pageIndex}`,
        { waitUntil: "networkidle" }
      );

      await closeOnboardingPopup(page);

      await downloadReportsFromPage(page, pageIndex, form.name);
    }

    console.log(`🎉 Finalizado formulário ${form.name}!`);
  }

  console.log("\n🏁 EXTRAÇÃO COMPLETA!");
}

// async function run() {
//   let page = await performLogin();

//   await closeOnboardingPopup(page);

//   // Exemplo — preencher atividade de ID 12345
//   // Form1: 9611604, Form2: 9611605, Form3: 9611606
//   const workId = 9611606;
//   const total = 200;

//   for (let i = 1; i <= total; i++) {
//     console.log(`\n🚀 [${i}/${total}] Preenchendo atividade ${workId}...`);

//     try {
//       await fillReport(page, workId);
//       console.log(`✅ Preenchimento ${i} concluído!`);
//     } catch (err) {
//       console.error(`❌ Erro no preenchimento ${i}:`, err);
//     }
//   }

//   console.log("🏁 Teste concluído");
// }

run();
