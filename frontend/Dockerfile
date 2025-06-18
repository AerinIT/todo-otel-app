FROM nginx:alpine

# Create directory for our app
WORKDIR /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy static files
COPY . .

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]