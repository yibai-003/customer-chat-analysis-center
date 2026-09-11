import { validateRuntimeConfig } from "./config";
import { startServer } from "./startup";

validateRuntimeConfig();
startServer();
