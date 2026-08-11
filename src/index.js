const amqpConnectionManager = require("./queue/connection");

// Centralized transaction dispatcher mapping queue events straight to automation targets
async function handleIncomingMessage(queueName, _payload) {
  console.log(`[Worker Engine] Routing task parameters for queue event: "${queueName}"`);
  
  try {
    switch (queueName) {
      case "lineup_updates":
        console.log("[Worker Engine] Invoking Lineup Adjustment Engine...");
        // TODO: Require and call lineup_bot.js execution method passing payload properties
        break;
        
      case "waiver_actions":
        console.log("[Worker Engine] Invoking Waiver Sniping Target Engine...");
        // TODO: Require and call waiver_sniper.js execution method passing payload properties
        break;
        
      default:
        console.warn(`[Worker Engine] Intercepted unsupported message format signature: ${queueName}`);
    }
    return true; // Return true on successful completion code run
  } catch (error) {
    console.error(`[Worker Engine] Critical failure processing automation routine: ${error.message}`);
    throw error; // Bubble up errors to handle message re-queuing safely
  }
}

async function bootDaemon() {
  console.log("[Worker Engine] Launching browser worker orchestrator background daemon...");
  
  try {
    // Initialize our managed RabbitMQ connection framework loops
    await amqpConnectionManager.initializeQueueConsumer(handleIncomingMessage);
    console.log("[Worker Engine] Background listener threads fully initialized. Standing by...");
  } catch (error) {
    console.error(`[Worker Engine] Critical cluster initialization failure: ${error.message}`);
    process.exit(1);
  }
}

// Global process monitoring to prevent memory-leak crashes from corrupting cluster states
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Fatal Worker Event] Unhandled rejection intercepted at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error(`[Fatal Worker Event] Uncaught system execution exception: ${error.message}`);
  process.exit(1);
});

bootDaemon();

