// This is a test file for checking pre-commit hooks.
const testVariable = "This was fixed";
console.log(testVariable);

// This should cause a more severe lint error
console.log(undeclaredVariable); // Using an undeclared variable
