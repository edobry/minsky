// Valid: execute without ValidationError (validation belongs in validate())
const command = {
  validate: async (params, context) => {
    if (!params.name) {
      throw new ValidationError("Name is required");
    }
  },
  execute: async (params, context) => {
    // No ValidationError here — all validation is in validate()
    const result = await doWork(params.name);
    return { success: true, result };
  },
};

// Valid: throwing other errors in execute is fine
const command2 = {
  execute: async (params, context) => {
    throw new Error("Something went wrong");
  },
};

// Valid: ValidationError outside execute is fine
function checkStuff() {
  throw new ValidationError("bad input");
}
