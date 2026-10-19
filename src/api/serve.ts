import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import mysql from "mysql2/promise";
import { database_config_from_environment } from "../contact_outreach_workflow/shared_files_orchestrator/outreach_database_(Integration).js";
import { create_import_server } from "./http_server.js";
import { MysqlWebsiteImportRepository } from "./mysql_import_repository.js";

if (existsSync(".env")) loadEnvFile(".env");
const token = process.env.CONTACT_US_SERVICE_TOKEN ?? "";
const host = process.env.CONTACT_US_API_HOST ?? "127.0.0.1";
const port = Number(process.env.CONTACT_US_API_PORT ?? "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CONTACT_US_API_PORT.");
const config = database_config_from_environment(process.env);
if (config.database !== "leadspot_main") throw new Error("The import API requires DB_NAME=leadspot_main.");
const pool = mysql.createPool({ ...config, connectionLimit: 5 });
const server = create_import_server(new MysqlWebsiteImportRepository(pool), token);
server.on("error", () => {
  console.error("ContactUs API could not listen.");
  void pool.end();
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`ContactUs import API listening on ${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => { void pool.end(); }));
}
