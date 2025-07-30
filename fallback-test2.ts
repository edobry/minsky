class DataProcessor {
  process(data) {
    return data;
  }
  
  async process(data) {
    // Enhanced processing with validation
    if (!data) return null;
    return this.validateAndProcess(data);
  }
  
  private validateAndProcess(data) {
    return data;
  }
}