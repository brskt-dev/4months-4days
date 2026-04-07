export const ROUTES = {
  signIn: "/auth/sign_in",
  works: "/works",
  reports: "/form_fills",
};

export const SELECTORS = {
  loginForm: "form#sign_in",
  loginEmail: 'input[name="user[email]"]',
  loginPassword: 'input[name="user[password]"]',
  loginButton: "input.login-button",
  logoutButton: "#logout-button",
  workMenuButton: "#work-menu-button",
  reportsMenuLink: 'a[href="/form_fills"]',
  reportFormDropdown: ".multiselect-option .multiselect.dropdown-toggle",
  reportFormOptions: ".multiselect-container li label.checkbox",
  reportRows: ".formFill-card table tbody tr",
  reportHeaders: ".formFill-card table thead th",
  paginationLinks: ".pagination a",
  exportButtons: ".formFill-card tbody tr td.column-export a",
  exportModalTitle: "#newExportRequestModalLabel",
  exportModalContent: "div.modal-content:visible",
  exportProfileSelect: "#export_request_export_profile_id",
  confirmExportButton: "#confirm_export_button",
  exportLoadingState: "#fileExportLoading",
  exportReadyState: "#fileExportReady",
  exportDownloadLink: "#fileDownloadLink",
  newFillLink: 'a[href*="/form_fills/new"]',
  editFieldButton: ".edit-field-value-button",
  fieldValueInput: "#fieldValueValue",
  saveFieldValueButton: "#saveFieldValueButton",
  modalDialog: ".modal-dialog",
};

export const TIMEOUTS = {
  popup: 2_000,
  short: 5_000,
  navigation: 15_000,
  login: 20_000,
  exportReady: 60_000,
};

export const CSV_HEADERS = [
  "FormName",
  "LocalName",
  "ReportDate",
  "Year",
  "ReportId",
  "SourcePage",
  "FilterFormId",
  "FilterLocalId",
  "FilterAssetId",
  "PlannedPath",
  "PlannedFileName",
];
