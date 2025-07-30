interface Config {
  apiKey: string;
  baseURL: string;
  timeout?: number;
}

function createConfig(): Config {
  return {
    apiKey: "test",
    baseURL: "https://api.example.com",
    timeout: 30000
  };
}