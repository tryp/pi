#!/usr/bin/env node

import process from "node:process";
import { checkModelData } from "./model-data-bootstrap.ts";

try {
	checkModelData();
	console.log("Generated model data is valid.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
