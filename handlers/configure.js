const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { program } = require("commander");

// Parse command-line arguments
program
  .option("--panel <url>", "URL of the panel (required)")
  .option("--key <key>", "Fixed configure key from the panel (required)")
  .parse(process.argv);

const options = program.opts();

if (!options.panel || !options.key) {
  console.error("Error: Both --panel and --key options are required.");
  console.error("Usage: npm run configure -- --panel https://panel.example.com --key YOUR_CONFIGURE_KEY");
  process.exit(1);
}

// Function to make HTTP/HTTPS request to the panel
function makeHttpRequest(url, method = "POST") {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https://");
    const lib = isHttps ? https : http;

    const req = lib.request(url, { method }, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(responseBody);
            resolve(parsed);
          } catch (e) {
            reject(new Error("Invalid JSON response from panel"));
          }
        } else {
          reject(
            new Error(
              `HTTP request failed with status ${res.statusCode}: ${responseBody}`
            )
          );
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// Main configuration function
async function configureNode() {
  const configPath = path.join(__dirname, "../config.json");

  console.log("🔄 Connecting to KS Panel to fetch full configuration...");

  // Build the configure URL - only the fixed configureKey is sent
  const configureUrl = new URL("/admin/nodes/configure", options.panel);
  configureUrl.searchParams.append("configureKey", options.key);

  try {
    // Request the FULL config from the panel
    const fullConfig = await makeHttpRequest(configureUrl.toString(), "POST");

    // Overwrite config.json with the complete configuration received from the panel
    fs.writeFileSync(configPath, JSON.stringify(fullConfig, null, 2));

    console.log("✅ Node configured successfully!");
    console.log("📁 Full configuration saved to config.json");
    console.log("\nCurrent config.json:");
    console.log(JSON.stringify(fullConfig, null, 2));

  } catch (error) {
    console.error("❌ Error configuring node:", error.message);
    
    if (error.message.includes("Node not found") || error.message.includes("configureKey")) {
      console.error("\nMake sure you copied the correct configure key from the panel.");
    }
    
    process.exit(1);
  }
}

// Run the configuration
configureNode();
