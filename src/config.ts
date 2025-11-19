import dotenv from "dotenv";
dotenv.config();

export const config = {
  email: process.env.PRODUTTIVO_EMAIL ?? "",
  password: process.env.PRODUTTIVO_PASSWORD ?? "",
  baseUrl: "https://app.produttivo.com.br"
};

if (!config.email || !config.password) {
  console.warn("⚠️ PRODUTTIVO_EMAIL ou PRODUTTIVO_PASSWORD ausentes no .env");
}
