-- Create the shadow database used by Prisma migrate dev.
-- Runs once on first container boot via /docker-entrypoint-initdb.d.
CREATE DATABASE harvoost_shadow OWNER harvoost;
