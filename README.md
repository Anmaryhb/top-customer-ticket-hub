# Top Customer Ticket Hub - Azure Static Web Apps Free

## Azure resources
1. Azure Static Web App, Plan type: Free.
2. Azure Cosmos DB for NoSQL with Free Tier enabled at account creation. Free tier is not serverless.

## Static Web App build settings
- App location: /app
- API location: /api
- Output location: leave blank

## Environment variables for Static Web App API
- COSMOS_CONNECTION_STRING
- COSMOS_DATABASE=TicketHub
- COSMOS_CONTAINER=Tickets
- ADMIN_EMAIL=your admin email

## Cosmos setup
Create database `TicketHub` and container `Tickets` with partition key `/id`. Enable the account Free Tier when creating it. Keep provisioned throughput within the free-tier allowance.

## Authentication
The included staticwebapp.config.json requires authentication and redirects users to Microsoft Entra sign-in. The preconfigured provider can admit Microsoft accounts; for a company-only deployment, configure a custom Microsoft Entra provider restricted to the intended tenant.

## Free pilot attachment limits
Attachments are stored inside Cosmos ticket records to avoid a separate paid storage service. The UI limits uploads to 3 files, 500 KB each. This is suitable only for a small pilot, not large evidence files.

## PDF
The admin view uses the browser's Print / Save as PDF function so there is no paid PDF service.
