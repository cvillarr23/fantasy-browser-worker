const amqp = require("amqplib");

// Load AMQP configuration topology safely from cluster-injected variables
const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@fantasy-broker.databases.svc.cluster.local:5672//";

async function connectWithRetry() {
  let attempts = 0;
  const maxAttempts = 10;
  const baseDelay = 2000; // 2 seconds base delay for exponential backoff

  while (attempts < maxAttempts) {
    try {
      console.log(`[Queue Bridge] Attempting connection to broker cluster endpoint: ${AMQP_URL} (Attempt ${attempts + 1}/${maxAttempts})`);
      const connection = await amqp.connect(AMQP_URL);
      console.log("[Queue Bridge] Socket baseline established with RabbitMQ successfully.");
      
      // Monitor socket lifecycle to handle automated recoveries
      connection.on("error", (err) => {
        console.error(`[Queue Bridge] Underlying connection socket error occurred: ${err.message}`);
      });

      connection.on("close", () => {
        console.error("[Queue Bridge] Connection closed by remote broker server pool. Triggering recycle...");
        setTimeout(connectWithRetry, baseDelay);
      });

      return connection;
    } catch (err) {
      attempts++;
      const currentDelay = baseDelay * Math.pow(2, attempts - 1);
      console.error(`[Queue Bridge] Connection failure: ${err.message}. Retrying in ${currentDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, currentDelay));
    }
  }
  throw new Error("Unable to establish communication channels with cluster messaging broker.");
}

async function initializeQueueConsumer(messageProcessorCallback) {
  const connection = await connectWithRetry();
  const channel = await connection.createChannel();

  // 1. Enforce strict resource boundaries to limit processing to 1 message at a time
  // This safeguards our 1200MiB pod limits by blocking concurrent Chromium execution cycles
  await channel.prefetch(1);
  console.log("[Queue Bridge] Resource concurrency limits locked successfully (Prefetch: 1).");

  // 2. Declare and align standard system tracking exchange queues
  const targetQueues = ["lineup_updates", "waiver_actions"];
  for (const queue of targetQueues) {
    await channel.assertQueue(queue, { durable: true });
    console.log(`[Queue Bridge] Bound tracking parameters for durable target queue: "${queue}"`);

    // 3. Register our persistent background worker consumers
    await channel.consume(queue, async (msg) => {
      if (msg !== null) {
        const payloadString = msg.content.toString();
        console.log(`[Queue Bridge] Inbound message captured from queue "${queue}"`);
        
        try {
          const parsedPayload = JSON.parse(payloadString);
          
          // Route data parameters to the application layer and wait for execution to complete
          await messageProcessorCallback(queue, parsedPayload);
          
          // Acknowledge transaction safely strictly AFTER execution finishes cleanly
          channel.ack(msg);
          console.log(`[Queue Bridge] Transaction acknowledged cleanly for message ID: ${msg.fields.deliveryTag}`);
        } catch (error) {
          console.error(`[Queue Bridge] Execution error encountered handling payload: ${error.message}`);
          
          // Re-queue message if processing fails due to unexpected transient errors
          console.log(`[Queue Bridge] Rejecting message ID ${msg.fields.deliveryTag}. Triggering cluster re-queue logic...`);
          channel.nack(msg, false, true); 
        }
      }
    }, { noAck: false }); // Disable dangerous automatic acks to ensure data safety
  }
}

module.exports = {
  initializeQueueConsumer
};

