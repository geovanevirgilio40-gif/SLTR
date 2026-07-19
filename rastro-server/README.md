# Rastro — backend multi-tenant, 100% Railway

Persistência real (PostgreSQL do Railway), isolamento entre clientes (tenants),
leitura protegida, rate limiting, geofencing com recuperação de estado, logs
estruturados, paginação. Pensado para correres o serviço todo dentro do Railway,
sem depender de mais nenhuma ferramenta externa.

## Modelo de chaves — importante perceber isto primeiro

```
SUPER_ADMIN_KEY  → és TU (dono do serviço). Cria/gere os teus clientes (tenants).
tenant.adminKey  → o TEU CLIENTE. Regista os dispositivos dele, cria geofences, vê tudo do seu tenant.
tenant.viewerKey → só leitura do tenant desse cliente — é a que pões no dashboard dele.
device.apiKey    → um dispositivo específico. Só reporta a própria posição.
```

Cada cliente teu (tenant) só vê e gere os seus próprios dispositivos — nunca os
de outro cliente.

## 1. Configurar no Railway

1. **Cria o projeto** a partir do teu repositório GitHub (como já tinhas feito).
2. **Adiciona o plugin PostgreSQL**: no projeto Railway → **+ New → Database →
   PostgreSQL**. Isto injeta `DATABASE_URL` automaticamente no serviço da app —
   não precisas de copiar nada à mão.
3. **(Opcional) Adiciona o plugin Redis**, só se um dia correres mais do que uma
   instância da app: **+ New → Database → Redis**. Injeta `REDIS_URL`
   automaticamente. Sem isto, tudo funciona à mesma numa só instância.
4. Nas **Variables** do serviço da app, define:
   - `SUPER_ADMIN_KEY` — gera uma chave forte (vê abaixo) e guarda-a só tu
   - `CORS_ORIGIN` — o domínio onde vais alojar o dashboard, quando o tiveres
   - `HISTORY_RETENTION_DAYS` — opcional, default 90

Para gerar uma chave forte (podes pedir-me para gerar uma a qualquer momento):
```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## 2. Criar o teu primeiro cliente (tenant)

```bash
curl -X POST https://o-teu-servico.railway.app/api/tenants \
  -H "Authorization: Bearer <SUPER_ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Empresa X — Entregas"}'
```

Resposta (guarda isto — só aparece uma vez):
```json
{"id":"...","name":"Empresa X — Entregas","adminKey":"...","viewerKey":"..."}
```

Entrega o `adminKey` a esse cliente (é ele que regista os dispositivos dele) e
usa o `viewerKey` no dashboard que lhe vais mostrar.

## 3. O cliente regista um dispositivo

```bash
curl -X POST https://o-teu-servico.railway.app/api/devices \
  -H "Authorization: Bearer <adminKey do tenant>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Estafeta 07","type":"entrega"}'
```

## 4. Enviar uma posição

**A. O admin do tenant reporta a posição de um dispositivo já registado:**
```bash
curl -X POST https://o-teu-servico.railway.app/api/devices/<id_do_dispositivo>/location \
  -H "Authorization: Bearer <adminKey do tenant>" \
  -H "Content-Type: application/json" \
  -d '{"lat":38.7369,"lng":-9.1427,"status":"ativo","speed":22}'
```

**B. O próprio dispositivo reporta a sua posição** (com a `apiKey` que recebeu
no registo):
```bash
curl -X POST https://o-teu-servico.railway.app/api/locations \
  -H "Authorization: Bearer <api_key do dispositivo>" \
  -H "Content-Type: application/json" \
  -d '{"lat":38.7369,"lng":-9.1427,"status":"ativo","speed":22}'
```

## 5. Ver no dashboard

Abre `rastro.html`. Ao carregar, pede uma chave de acesso — usa o `adminKey`
ou o `viewerKey` desse tenant. Se fores hospedar um dashboard fixo por cliente,
podes saltar esse ecrã definindo, antes do resto do script:
```html
<script>
  window.RASTRO_SERVER_URL = "https://o-teu-servico.railway.app";
  window.RASTRO_ACCESS_KEY = "<viewerKey do tenant>";
</script>
```

## Correções desta revisão

| # | Problema | Correção |
|---|----------|----------|
| 1 | Armazenamento não persistente no Railway | PostgreSQL (plugin Railway) — sobrevive a redeploys/reinícios; o SQLite anterior vivia no container efémero |
| 2 | Contradição Redis vs. SQLite single-instance | Resolvida: Postgres é a fonte de verdade única e partilhada; Redis (também plugin Railway) passa a servir só para sincronizar o Socket.io entre várias instâncias, via `@socket.io/redis-adapter` — deixou de ser uma reimplementação manual |
| 3 | Leitura pública (`GET /api/locations`, `/api/geofences/events`) | Agora exige `admin_key` ou `viewer_key` do tenant |
| 4 | Sem isolamento entre clientes | Modelo multi-tenant: cada cliente só vê/gere os seus próprios dispositivos e geofences |
| 5 | Sem backups | Ver nota abaixo |
| 6 | Sem termos de serviço/privacidade | Ver nota abaixo |

## Nota sobre backups

O Postgres do Railway costuma ter opção de snapshots/backups automáticos nas
definições da base de dados — mas como isto pode ter mudado desde que fui
treinado, confirma na tua conta Railway atual (Settings da base de dados) qual
é a política de backup incluída no teu plano, e ativa-a. Não confies só na
persistência "não se perde ao reiniciar" — um backup protege-te de apagares
dados por engano, não só de reinícios.

## Nota sobre termos de serviço e privacidade

Isto vai tratar de localizações de pessoas reais — isso tem implicações legais
(proteção de dados, consentimento, retenção) que variam consoante o país onde
vendes o serviço. Não sou advogado e não te posso dar essa orientação com
segurança — vale a pena consultares um antes de teres o primeiro cliente
pagante, especialmente para o tipo `pessoa` (localização de indivíduos, não só
de veículos/ativos).

## Testado localmente, mas não em produção real

Sem acesso à rede neste ambiente, não corri isto contra um Postgres/Redis reais
do Railway. Testei a lógica de negócio (isolamento entre tenants, hashing de
chaves, geofencing com recuperação de estado após "reinício") com um Postgres
simulado localmente — confirmei que os cenários certos passam. Ainda assim,
antes de teres o primeiro cliente pagante, corre os testes end-to-end reais
contra o teu Railway.

## Endpoints

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/api/tenants` | super admin | Cria um cliente teu, devolve `adminKey`/`viewerKey` |
| GET | `/api/tenants` | super admin | Lista clientes |
| POST | `/api/tenants/:id/suspend` | super admin | Suspende um cliente (bloqueia tudo, sem apagar dados) |
| POST | `/api/tenants/:id/unsuspend` | super admin | Reativa |
| POST | `/api/devices` | tenant admin | Regista um dispositivo |
| GET | `/api/devices` | tenant admin | Lista dispositivos do tenant |
| DELETE | `/api/devices/:id` | tenant admin | Revoga um dispositivo |
| POST | `/api/devices/:id/location` | tenant admin | Reporta a posição de um dispositivo |
| POST | `/api/locations` | device | O próprio dispositivo reporta a posição |
| GET | `/api/locations` | tenant admin/viewer | Snapshot do tenant |
| GET | `/api/locations/:id/history` | tenant admin/viewer | Histórico paginado |
| POST | `/api/geofences` | tenant admin | Cria zona |
| GET | `/api/geofences` | tenant admin/viewer | Lista zonas do tenant |
| DELETE | `/api/geofences/:id` | tenant admin | Remove zona |
| GET | `/api/geofences/events` | tenant admin/viewer | Histórico de entradas/saídas |
| GET | `/api/health` | — | Estado do servidor (sem dados sensíveis) |

## Variáveis de ambiente

| Variável | Origem | Descrição |
|---|---|---|
| `DATABASE_URL` | Railway (Postgres plugin) | Automática |
| `REDIS_URL` | Railway (Redis plugin, opcional) | Automática |
| `PORT` | Railway | Automática |
| `SUPER_ADMIN_KEY` | Tu | Gerida por ti, guarda bem |
| `CORS_ORIGIN` | Tu | Domínio do dashboard em produção |
| `HISTORY_RETENTION_DAYS` | Tu | Default 90 |
| `FORCE_HTTPS` | Tu | `true` para rejeitar pedidos não seguros (o Railway já serve HTTPS por defeito) |
| `LOG_LEVEL` | Tu | Default `info` |
