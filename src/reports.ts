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
 * Aplica filtros direto pela URL da Produttivo.
 * Eliminamos cliques, dropdowns e datepickers.
 */
export async function applyFilters(
  page: Page,
  options: {
    formId?: string | null;
    startDate: string;
    endDate: string;
  }
) {
  console.log("➡️ Aplicando filtros via URL...");

  const { formId, startDate, endDate } = options;

  const base = "https://app.produttivo.com.br/form_fills";
  const url = new URL(base);

  url.searchParams.append("utf8", "✓");

  // Formulário
  if (formId) {
    url.searchParams.append("form_fill[form_ids][]", formId);
  } else {
    url.searchParams.append("form_fill[form_ids][]", "");
  }

  // Range de datas
  url.searchParams.append("range_time", `${startDate} - ${endDate}`);

  url.searchParams.append("account_id", "259345");
  url.searchParams.append("field_id", "-2");
  url.searchParams.append("order_type", "desc");

  const finalUrl = url.toString();

  console.log("🔗 URL Final dos filtros:");
  console.log(finalUrl);

  await closeOnboardingPopup(page);

  await page.goto(finalUrl, { waitUntil: "networkidle" });

  await closeOnboardingPopup(page);

  console.log("✅ Filtros aplicados com sucesso!");
}

/**
 * Extrai todos os tipos de formulários disponíveis no filtro.
 */
export async function extractFormTypes(page: Page) {
  console.log("➡️ Extraindo lista de formulários...");

  // abre o dropdown correto
  await page.click(".multiselect-option .multiselect.dropdown-toggle");
  await closeOnboardingPopup(page);

  // espera os itens carregarem
  await page.waitForSelector(".multiselect-container li label.checkbox");

  const items = await page.$$(".multiselect-container li label.checkbox");

  const forms = [];

  for (const item of items) {
    const input = await item.$("input[type='checkbox']");
    if (!input) continue;

    const formId = await input.getAttribute("value");
    const label = (await item.innerText()).trim();

    // ignora valores inválidos
    if (!formId || isNaN(Number(formId))) continue;

    // ignora itens que não são formulários
    if (label.toLowerCase().includes("projeto")) continue;

    forms.push({ id: formId, name: label });
  }

  // fecha dropdown para não atrapalhar UI
  await page.click(".multiselect-option .multiselect.dropdown-toggle");

  console.log("📌 Tipos encontrados:");
  forms.forEach((f) => console.log(` - [${f.id}] ${f.name}`));

  console.log(`📌 ${forms.length} formulários detectados.`);

  return forms;
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
 * Baixa um único relatório e salva dentro da pasta do tipo de formulário.
 * @param page Playwright Page
 * @param exportButtonSelector seletor do botão <a> que abre o modal
 * @param formName Nome do formulário atual (ex: "Teste 01")
 */
export async function downloadReport(
  page: Page,
  exportButtonSelector: string,
  formName: string
): Promise<void> {
  console.log(
    `➡️ Iniciando download do relatório usando: ${exportButtonSelector}`
  );

  // Sanitiza nome da pasta
  const safeName = formName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-zA-Z0-9_-]/g, "_"); // troca caracteres especiais

  const folder = `downloads/${safeName}`;

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

  // Exportar
  await modal.locator("#confirm_export_button").click();
  console.log("➡️ Gerando relatório...");

  // Loading e Ready
  await modal
    .locator("#fileExportLoading")
    .waitFor({ state: "visible", timeout: 10000 })
    .catch(() => {});
  await modal
    .locator("#fileExportReady")
    .waitFor({ state: "visible", timeout: 60000 })
    .catch(() => {});

  const downloadPromise = page.waitForEvent("download");

  if (await modal.locator("#fileDownloadLink").isVisible()) {
    await modal
      .locator("#fileDownloadLink")
      .click()
      .catch(() => {});
  }

  const download = await downloadPromise;
  const suggested = download.suggestedFilename();

  // Cria pasta específica
  await fs.promises.mkdir(folder, { recursive: true });

  const savePath = `${folder}/${suggested}`;

  await download.saveAs(savePath);

  console.log(`📥 Download salvo como: ${savePath}`);

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
  pageIndex: number,
  formName: string
): Promise<number> {
  console.log(`\n📄 [PAGE ${pageIndex}] Extraindo relatórios desta página...`);

  const exportButtons = await page.$$(
    ".formFill-card tbody tr td.column-export a"
  );
  console.log(
    `➡️ Encontrados ${exportButtons.length} relatórios nesta página.`
  );

  let successCount = 0;

  for (let i = 0; i < exportButtons.length; i++) {
    const btn = exportButtons[i];

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
      await downloadReport(page, selector, formName);
      successCount++;
    } catch (err) {
      console.error(`❌ Erro ao baixar relatório ${id}:`, err);
    }

    await closeOnboardingPopup(page);
  }

  console.log(
    `✅ Página ${pageIndex}: ${successCount}/${exportButtons.length} baixados com sucesso.`
  );

  return successCount;
}
