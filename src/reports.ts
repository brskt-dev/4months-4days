import fs from "fs";
import { Page } from "playwright";
import { closeOnboardingPopup } from "./helpers/closePopup";

/**
 * Navega até a página de relatórios.
 * @param page Playwright Page
 */
export async function goToReports(page: Page): Promise<Page> {
  console.log("➡️ Abrindo menu 'Gestão de Serviços'...");

  // abre o dropdown do menu
  await page.click("#work-menu-button");

  // espera o item ficar visível
  await page.waitForSelector('a[href="/form_fills"]', { timeout: 5000 });

  console.log("➡️ Acessando 'Preenchimentos Realizados / Relatórios'...");

  await page.click('a[href="/form_fills"]');

  // confirma a navegação
  await page.waitForURL("**/form_fills", { timeout: 15000 });

  console.log("✅ Página de relatórios aberta com sucesso!");
  console.log("📄 URL:", page.url());

  return page;
}

/**
 * Aplica o filtro de datas "Personalizado" com intervalo de 01/01/2000 até hoje.
 * @param page Playwright Page
 */
export async function applyDateFilter(page: Page): Promise<void> {
  console.log("➡️ Aplicando filtro de datas...");

  // abre o datepicker
  await page.waitForSelector("#formFill-rangeDate");
  await page.click("#formFill-rangeDate");

  // espera o dropdown do datepicker aparecer
  await page.waitForSelector(".daterangepicker", { state: "visible" });

  console.log("➡️ Selecionando modo Personalizado...");

  // clica na opção "Personalizado"
  await page.click('.ranges ul li[data-range-key="Personalizado"]');

  // preenchendo o campo ESQUERDO
  console.log("➡️ Preenchendo data inicial...");

  await page.fill('input[name="daterangepicker_start"]', "01/01/2000");

  // (campo da direita não precisa alterar — já vem com hoje e está correto)

  // botão aplicar (dentro do picker)
  console.log("➡️ Aplicando intervalo no picker...");
  await page.click(".applyBtn.btn.btn-sm.btn-success");

  // agora sim clicar no botão Filtrar da página
  console.log("➡️ Clicando em 'Filtrar'...");

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle" }),
    page.click(".formFill-submit"),
  ]);

  // só para garantir que nenhum popup atrapalhe
  await closeOnboardingPopup(page);

  console.log("✅ Filtro aplicado com sucesso!");
}

/**
 * Extrai o total de relatórios disponíveis na página.
 * @param page Playwright Page
 */
export async function extractTotalReports(page: Page) {
  console.log("➡️ Calculando total de relatórios...");

  // --- conta registros da página atual ---
  const rowsCount = await page.locator(".formFill-card table tbody tr").count();
  console.log(`📄 Registros por página: ${rowsCount}`);

  // --- extrai números das páginas ---
  const pageLinks = await page.locator(".pagination a").allInnerTexts();

  const pageNumbers = pageLinks
    .map((txt) => parseInt(txt.trim()))
    .filter((n) => !isNaN(n));

  if (!pageNumbers.length) {
    throw new Error("❌ Falha ao extrair número de páginas.");
  }

  const totalPages = Math.max(...pageNumbers);
  console.log(`📄 Total de páginas detectadas: ${totalPages}`);

  // --- abre a última página para contar registros reais ---
  console.log("➡️ Abrindo última página para contagem precisa...");
  await page.goto(
    `https://app.produttivo.com.br/form_fills?page=${totalPages}`
  );
  await page.waitForSelector(".formFill-card table tbody tr");

  const lastPageCount = await page
    .locator(".formFill-card table tbody tr")
    .count();

  console.log(`📄 Registros na última página: ${lastPageCount}`);

  // --- cálculo total REAL ---
  const totalReports = rowsCount * (totalPages - 1) + lastPageCount;

  console.log("📌 Totais finais:");
  console.log(`- Registros por página (padrão): ${rowsCount}`);
  console.log(`- Total de páginas:              ${totalPages}`);
  console.log(`- Registros da última página:   ${lastPageCount}`);
  console.log(`- TOTAL GERAL DE RELATÓRIOS:    ${totalReports}`);

  // 🔥 VOLTA PARA A PÁGINA 1 ANTES DE RETORNAR
  console.log("➡️ Retornando para a página 1...");
  await page.goto("https://app.produttivo.com.br/form_fills?page=1");
  await page.waitForSelector(".formFill-card table tbody tr");

  return {
    reportsPerPage: rowsCount,
    lastPageCount,
    totalPages,
    totalReports,
  };
}

/**
 * Baixa um único relatório.
 * @param page Playwright Page
 * @param exportButtonSelector seletor do botão <a> que abre o modal
 */
export async function downloadReport(
  page: Page,
  exportButtonSelector: string
): Promise<void> {
  console.log(
    `➡️ Iniciando download do relatório usando: ${exportButtonSelector}`
  );

  // Abre o popup
  await page.click(exportButtonSelector);

  // Aguarda o modal REAL abrir
  await page.waitForSelector("#newExportRequestModalLabel", { timeout: 15000 });

  const modal = page.locator("div.modal-content:visible");

  console.log("➡️ Modal aberto, selecionando tipo de exportação...");

  // Seleciona option
  await modal.locator("#export_request_export_profile_id").waitFor();
  const options = await modal
    .locator("#export_request_export_profile_id option")
    .all();

  if (options.length === 0)
    throw new Error("Nenhuma opção de exportação disponível!");

  const firstValue = await options[0].getAttribute("value");
  await modal
    .locator("#export_request_export_profile_id")
    .selectOption(firstValue!);

  console.log(`➡️ Tipo selecionado: option value = ${firstValue}`);

  // Clica Exportar
  await modal.locator("#confirm_export_button").click();

  console.log("➡️ Gerando relatório...");

  // Loading
  await modal
    .locator("#fileExportLoading")
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});

  // Final
  await modal
    .locator("#fileExportReady")
    .waitFor({ state: "visible", timeout: 60000 })
    .catch(() => {
      console.warn(
        "⚠️ Timeout esperando 'ready', mas o download pode ter sido automático."
      );
    });

  const downloadPromise = page.waitForEvent("download");

  if (await modal.locator("#fileDownloadLink").isVisible()) {
    await modal.locator("#fileDownloadLink").click();
  }

  // aguarda
  const download = await downloadPromise;

  // nome original sugerido
  const suggested = download.suggestedFilename();

  // cria diretório local, se não existir
  await fs.promises.mkdir("downloads", { recursive: true });

  // salva
  await download.saveAs(`downloads/${suggested}`);

  console.log(`📥 Download salvo como: downloads/${suggested}`);

  // Espera modal fechar
  await modal.waitFor({ state: "hidden", timeout: 15000 });

  console.log("✅ Relatório baixado com sucesso!");

  await closeOnboardingPopup(page);
}

/**
 * Baixa todos os relatórios da página atual.
 * @param page Playwright Page
 * @param pageIndex índice da página (1-based) para logs
 * @returns número de relatórios baixados com sucesso
 */
export async function downloadReportsFromPage(
  page: Page,
  pageIndex: number
): Promise<number> {
  console.log(`\n📄 [PAGE ${pageIndex}] Extraindo relatórios desta página...`);

  // Seleciona apenas os botões dentro da tabela correta
  const exportButtons = await page.$$(
    ".formFill-card tbody tr td.column-export a"
  );

  console.log(
    `➡️ Encontrados ${exportButtons.length} relatórios nesta página.`
  );

  let successCount = 0;

  for (let i = 0; i < exportButtons.length; i++) {
    const btn = exportButtons[i];

    // recupera o id do botão para clicar via seletor
    const id = await btn.getAttribute("id");
    if (!id) {
      console.warn("⚠️ Botão sem ID detectado — ignorando.");
      continue;
    }

    const selector = `#${id}`;

    console.log(
      `➡️ [${i + 1}/${
        exportButtons.length
      }] Baixando relatório (${selector})...`
    );

    try {
      await downloadReport(page, selector);
      successCount++;
    } catch (err) {
      console.error(`❌ Erro ao baixar relatório ${id}:`, err);
      // continua mesmo assim
    }

    await closeOnboardingPopup(page);
  }

  console.log(
    `✅ Página ${pageIndex}: ${successCount}/${exportButtons.length} baixados com sucesso.`
  );

  return successCount;
}
