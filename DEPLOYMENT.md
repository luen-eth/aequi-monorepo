# Production Deployment Guide

## Prerequisites

1. **Environment Variables**: Copy `.env.example` files and fill in production values
2. **RPC Providers**: Ensure you have reliable RPC endpoints configured
3. **Domain**: Set up your domain with SSL/TLS
4. **Docker**: Install Docker and Docker Compose on your server

## Deployment Options

### Option 1: Docker Compose (Recommended)

1. **Build Images**:
   ```bash
   docker-compose -f docker-compose.yml build
   ```

2. **Start Services**:
   ```bash
   docker-compose up -d
   ```

3. **Check Logs**:
   ```bash
   docker-compose logs -f
   ```

### Option 2: GitHub Container Registry

1. **Pull Images**:
   ```bash
   docker pull ghcr.io/aloshai/aequi-monorepo/server:latest
   docker pull ghcr.io/aloshai/aequi-monorepo/web:latest
   ```

2. **Run with Docker Compose**:
   ```yaml
   services:
     server:
       image: ghcr.io/aloshai/aequi-monorepo/server:latest
       # ... rest of config
   ```

### Option 3: Kubernetes

See `k8s/` directory for Kubernetes manifests (create if needed).

## Health Checks

- **Liveness**: `GET /health/live` - checks if server is running
- **Readiness**: `GET /health/ready` - checks if server can serve traffic
- **Full Health**: `GET /health` - detailed status of all chains

## Monitoring

### Recommended Tools
- **Uptime**: UptimeRobot, Pingdom
- **Logs**: CloudWatch, DataDog, Grafana Loki
- **Metrics**: Prometheus + Grafana
- **APM**: New Relic, DataDog

### Key Metrics to Monitor
- Response time per endpoint
- Error rate
- RPC endpoint availability
- Docker container resource usage
- Rate limit hits

## Scaling

### Horizontal Scaling
Run multiple server instances behind a load balancer:

```yaml
services:
  server:
    deploy:
      replicas: 3
```

### Vertical Scaling
Increase container resources:

```yaml
services:
  server:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
```

## Security Checklist

- [ ] Environment variables are not committed
- [ ] CORS is properly configured
- [ ] Rate limiting is enabled
- [ ] HTTPS/TLS is configured
- [ ] Security headers are set (nginx)
- [ ] Regular dependency updates
- [ ] Docker images are scanned for vulnerabilities
- [ ] Secrets are managed securely (e.g., AWS Secrets Manager)

## Rollback Procedure

1. **Identify the last working version**:
   ```bash
   git log --oneline
   ```

2. **Revert to previous version**:
   ```bash
   git revert <commit-hash>
   git push
   ```

3. **Or use tagged images**:
   ```bash
   docker pull ghcr.io/aloshai/aequi-monorepo/server:v1.0.0
   ```

## Troubleshooting

### Server won't start
1. Check environment variables: `docker-compose config`
2. View logs: `docker-compose logs server`
3. Verify RPC endpoints are accessible

### No routes found
1. Check RPC connectivity in health endpoint
2. Verify DEX configurations in constants
3. Check token addresses

### High memory usage
1. Check for memory leaks in logs
2. Reduce cache TTL values
3. Scale horizontally instead

## Performance Optimization

1. **Enable caching**: Configured via `QUOTE_TTL_SECONDS`
2. **Use CDN**: For frontend assets
3. **Database**: Consider adding Redis for caching (future enhancement)
4. **Connection pooling**: Already handled by Viem

## Backup & Recovery

### Database (if added later)
- Set up automated backups
- Test restore procedures regularly

### Configuration
- Keep `.env` files in secure storage
- Document all custom configurations

## Updates

1. **Pull latest changes**:
   ```bash
   git pull origin main
   ```

2. **Rebuild and restart**:
   ```bash
   docker-compose down
   docker-compose build
   docker-compose up -d
   ```

3. **Verify health**:
   ```bash
   curl https://your-domain.com/health
   ```

## Support

For issues or questions:
- GitHub Issues: https://github.com/aloshai/aequi-monorepo/issues
- Documentation: See README.md
