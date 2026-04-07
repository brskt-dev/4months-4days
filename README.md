# 4months-4days

Automacao em TypeScript com Playwright para extracao rastreavel de relatorios do Produttivo.

## Fluxo

O scraper agora executa nesta ordem:

1. Autenticar
2. Planejar a extracao
3. Registrar inventario e estado de execucao
4. Solicitar exportacao e baixar PDFs
5. Validar arquivos salvos
6. Consolidar resumo final

Nenhum download comeca antes do inventario do run ser gerado.

## Saidas

PDFs:

`downloads/FormName/LocalName/Year/ReportId.pdf`

Artefatos de controle:

`automation-artifacts/control/execution-state.json`
Estado persistente por `report_id`, usado para retomada segura.

`automation-artifacts/runs/<runId>/planning.json`
Inventario planejado do run.

`automation-artifacts/runs/<runId>/planning.csv`
Arquivo de conferencia humana.

`automation-artifacts/runs/<runId>/events.ndjson`
Logs estruturados por etapa.

`automation-artifacts/runs/<runId>/summary.json`
Resumo consolidado da execucao.

`automation-artifacts/runs/<runId>/summary.txt`
Resumo textual rapido.

## Estrutura

`src/workflows/scrapeReports.ts`
Orquestra autenticacao, planejamento, execucao e consolidacao.

`src/planning/planner.ts`
Descobre itens da listagem e monta o inventario antes da extracao.

`src/execution/reportExecutor.ts`
Retoma, controla tentativas, exporta, baixa e valida cada item.

`src/storage/`
Persistencia do estado global e artefatos por run.

`src/logging/runLogger.ts`
Logs estruturados em `NDJSON`.

`src/reports.ts`
Interacoes Playwright com a pagina de relatorios.

## Scripts

`npm run scrape`
Executa a automacao completa de extracao.

`npm run fill`
Executa o fluxo de preenchimento auxiliar.

## Variaveis de ambiente

Use `.env.example` como referencia.

`PRODUTTIVO_EMAIL`
Credencial de login.

`PRODUTTIVO_PASSWORD`
Credencial de senha.
Se houver caracteres como `#`, `;`, espacos ou `=`, use aspas no `.env`.

`PRODUTTIVO_BASE_URL`
Base do ambiente Produttivo.

`PRODUTTIVO_ACCOUNT_ID`
Conta usada na URL de filtros.

`DOWNLOADS_DIR`
Pasta raiz dos PDFs.

`AUTOMATION_ARTIFACTS_DIR`
Pasta raiz dos artefatos de controle.

`REPORT_START_DATE`
Data inicial padrao.

`REPORT_END_DATE`
Data final padrao.

`REPORT_LOCAL_QUERY_PARAM`
Nome do parametro de query usado pelo filtro de local, se esse filtro for aplicado via URL.

`REPORT_ASSET_QUERY_PARAM`
Nome do parametro de query usado pelo filtro de ativo, se esse filtro for aplicado via URL.

`EXTRACTION_PLAN_FILE`
Caminho para um JSON com escopos planejados. Se vazio, a automacao descobre formularios e cria escopos automaticamente.

`RESUME_FROM_CONTROL`
Quando `true`, pula o planning e retoma a execucao diretamente do `execution-state.json`.

`MAX_RETRIES`
Limite de tentativas por item.

`PLANNING_CONCURRENCY`
Quantidade maxima de escopos processados em paralelo na fase de planning.

`DOWNLOAD_CONCURRENCY`
Quantidade maxima de workers de download.

`EXPORT_POLL_INTERVAL_MS`
Intervalo de polling da exportacao.

`SKIP_VALIDATED`
Pula itens ja validados quando possivel.

`OVERWRITE_EXISTING`
Forca reprocessamento mesmo com PDF valido no destino.

## Plano de extracao

Se quiser controlar combinacoes especificas de filtros, use `EXTRACTION_PLAN_FILE` apontando para um JSON como `extraction-plan.example.json`.

Cada escopo pode informar:

`formId`, `formName`, `localId`, `localName`, `assetId`, `assetName`, `startDate`, `endDate`, `extraQueryParams`

## Observacoes

O nome original retornado pela plataforma nao e usado como identificador final do arquivo.

O nome salvo localmente e deterministico:

`ReportId.pdf`

Como o caminho ja incorpora formulario, local e ano, isso reduz ambiguidades e facilita retomada e deduplicacao.
