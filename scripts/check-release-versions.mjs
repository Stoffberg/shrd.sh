import { readFileSync } from "node:fs"

const manifests = [
  "package.json",
  "apps/api/package.json",
  "packages/db/package.json",
  "packages/sdk/package.json",
  "packages/shared/package.json",
]

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

const cargoToml = readFileSync("cli/Cargo.toml", "utf8")
const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1]
const cargoRepository = cargoToml.match(/^repository = "([^"]+)"/m)?.[1]
const expectedRepository = "https://github.com/Stoffberg/shrd.sh"

if (!cargoVersion) {
  console.error("Could not read cli/Cargo.toml version")
  process.exit(1)
}

if (cargoRepository !== expectedRepository) {
  console.error(`Expected cli/Cargo.toml repository to be ${expectedRepository}`)
  console.error(`cli/Cargo.toml: ${cargoRepository ?? "missing"}`)
  process.exit(1)
}

const mismatches = manifests
  .map((path) => ({ path, version: readJson(path).version }))
  .filter((entry) => entry.version !== cargoVersion)

if (mismatches.length > 0) {
  console.error(`Expected package versions to match CLI ${cargoVersion}`)
  for (const mismatch of mismatches) {
    console.error(`${mismatch.path}: ${mismatch.version}`)
  }
  process.exit(1)
}

console.log(`Release metadata aligned at ${cargoVersion}`)
