FROM node:18

# Install dependencies for Chromaprint and ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libchromaprint1 \
    libchromaprint-tools \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Verify fpcalc is installed and working
RUN which fpcalc && fpcalc -version

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

RUN npm install

# Bundle app source
COPY . .

# Create uploads directory
RUN mkdir -p uploads

# Expose port
EXPOSE 8080

# Set environment variable for port (Cloud Run uses 8080)
ENV PORT=8080

# Start the application
CMD [ "node", "index.js" ]
