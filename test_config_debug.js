async function testConfigs() {
  try {
    // Test node-config
    const nodeConfig = require('config');
    console.log('=== NODE CONFIG ===');
    console.log('sessiondb.backend:', nodeConfig.get('sessiondb.backend'));
    
    // Test custom config
    console.log('\n=== CUSTOM CONFIG ===');
    const { CustomConfigFactory } = require('./src/domain/configuration/index.ts');
    const factory = new CustomConfigFactory();
    const provider = await factory.createProvider();
    const config = provider.getConfig();
    console.log('sessiondb.backend:', config.sessiondb.backend);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testConfigs();
