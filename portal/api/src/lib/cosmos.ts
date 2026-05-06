import { CosmosClient, Database, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

let client: CosmosClient | null = null;
let database: Database | null = null;

function getClient(): CosmosClient {
  if (!client) {
    const endpoint = process.env.COSMOS_ENDPOINT;
    if (!endpoint) {
      throw new Error("COSMOS_ENDPOINT not configured");
    }
    client = new CosmosClient({
      endpoint,
      aadCredentials: new DefaultAzureCredential(),
    });
  }
  return client;
}

function getDatabase(): Database {
  if (!database) {
    const dbName = process.env.COSMOS_DATABASE_NAME;
    if (!dbName) {
      throw new Error("COSMOS_DATABASE_NAME not configured");
    }
    database = getClient().database(dbName);
  }
  return database;
}

export const containers = {
  states: (): Container => getDatabase().container("states"),
  chunks: (): Container => getDatabase().container("chunks"),
};
