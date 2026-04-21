// Invalid: ValidationError thrown inside execute()
const command = {
  execute: async (params, context) => {
    if (!params.name) {
      throw new ValidationError("Name is required"); // should be in validate()
    }
    return { success: true };
  },
};
