FROM oven/bun:latest

WORKDIR /app

# Copy package.json and bun.lock
COPY package.json bun.lock ./

# Install dependencies
RUN bun install

# Copy the rest of the code
COPY . .

# Link the CLI globally
RUN bun link

# Expose any necessary ports
# EXPOSE 3000

# Set the entry point
ENTRYPOINT ["bun", "run", "src/cli.ts"]