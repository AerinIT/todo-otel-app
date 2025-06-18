FROM node:20-alpine

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build TypeScript code
RUN npm run build

# Set environment variables
ENV NODE_ENV=production

# Start the service (will be overridden by docker-compose)
CMD ["npm", "run", "start:todo"] 