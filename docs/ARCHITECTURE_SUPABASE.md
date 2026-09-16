# Arquitetura Supabase-first

Este fork transforma o open-autoDM em uma plataforma multicanal semelhante ao ManyChat, mantendo uma rota de homologação sem custo obrigatório.

## Decisão de base

A base escolhida é `harshithgangone/open-autodm` (MIT), fixada inicialmente no commit `2e5ada2f1f6fea960162f81c76179aab9d6a0abf`.

Ela foi escolhida porque já possui:

- Next.js compatível com Vercel;
- Supabase Postgres, Auth e Storage;
- fila durável no PostgreSQL com deduplicação, retry e `FOR UPDATE SKIP LOCKED`;
- `pg_cron` + `pg_net` para processamento periódico;
- OAuth oficial do Instagram, webhook assinado e tokens criptografados;
- nenhuma dependência obrigatória de Redis, TimescaleDB, worker permanente ou API social terceirizada.

ChatbotX foi descartado como fundação porque suas migrations obrigatórias usam TimescaleDB e sua execução depende de serviços que não cabem no requisito Supabase/Vercel. ZernFlow será usado somente como referência MIT para o canvas, o modelo de fluxos e o inbox; sua dependência da API Zernio não será incorporada.

## Arquitetura-alvo

```text
Navegador
   |
   v
Next.js no Vercel
   |-- painel, construtor, inbox e APIs
   |-- callbacks OAuth oficiais da Meta
   |-- webhooks Instagram e Messenger
   |-- provedores de IA server-to-server
   |
   v
Supabase
   |-- Auth + RLS
   |-- Postgres
   |-- Storage
   |-- Realtime
   |-- fila Postgres / Supabase Queues
   |-- pg_cron + pg_net
   `-- Vault para segredos de agendamento
```

Não haverá:

- TimescaleDB;
- Redis/BullMQ;
- servidor worker permanente;
- banco fora do Supabase;
- Zernio ou outro intermediário obrigatório para Meta OAuth/mensageria;
- chave de IA exposta no navegador;
- autenticação pessoal do Codex usada como API de inferência.

## Modelo multicanal

O modelo específico de Instagram será gradualmente substituído por entidades genéricas:

- `workspaces` e `workspace_members`;
- `channels` para Instagram e Facebook/Messenger;
- `channel_credentials`, sempre criptografadas;
- `contacts` e `contact_identities`;
- `conversations` e `messages`;
- `flows`, `flow_versions`, `flow_nodes` e `flow_edges`;
- `flow_runs` e `flow_waits`;
- `jobs` ou Supabase Queues para tarefas assíncronas;
- `ai_providers` e `ai_models` por workspace.

Todas as tabelas de tenant devem carregar `workspace_id` e usar RLS. Rotas server-side devem derivar usuário/workspace da sessão Supabase; IDs recebidos do navegador nunca serão tratados como prova de propriedade.

## Meta OAuth

### Instagram

Preservar o fluxo existente com Instagram Login, `state` assinado, tokens criptografados, validação HMAC e renovação de token.

### Facebook/Messenger

Implementar diretamente com Facebook Login e Graph API:

1. autorização do administrador;
2. solicitação das permissões necessárias;
3. listagem e seleção de Páginas;
4. armazenamento criptografado de Page Access Token;
5. assinatura de webhooks por Página;
6. ingestão de mensagens e postbacks;
7. envio por Messenger Platform;
8. desconexão e revogação.

As permissões exatas e o uso público dependem da revisão do aplicativo Meta.

## IA BYOK

A IA será exclusivamente server-to-server:

- OpenAI API;
- provedores OpenAI-compatible com allowlist de protocolos/hosts;
- chave criptografada por workspace;
- endpoint e modelo configuráveis;
- limites de tokens, timeout, auditoria e teste de conexão;
- proteção contra SSRF em endpoints personalizados.

Login ChatGPT/Codex não é uma credencial de API incorporável e não será utilizado.

## Homologação gratuita

A homologação inicial pode usar:

- GitHub público: US$ 0;
- Vercel Hobby: US$ 0 para uso pessoal/não comercial e dentro das cotas;
- Supabase Free: US$ 0 dentro das cotas;
- Meta Developer App em modo Development: sem cobrança de infraestrutura;
- provedor de IA apenas quando uma chave BYOK for configurada.

Limitações importantes:

- Vercel Hobby restringe uso comercial; publicação comercial pode exigir plano Pro;
- projetos Supabase Free podem pausar após uma semana de inatividade;
- cotas de banco, Storage, egress e Functions continuam valendo;
- provedores de IA podem cobrar por uso;
- produção pública de Instagram/Messenger exige permissões e App Review da Meta.

A meta de custo zero vale para desenvolvimento e homologação de baixo volume, não como garantia de produção comercial ilimitada.

## Fases de entrega

1. **Fundação:** CI, testes, papéis owner/admin, RLS e isolamento do Storage.
2. **Modelo multicanal:** channels, contacts, conversations e messages.
3. **Messenger:** OAuth de Páginas, webhooks, inbox e envio.
4. **Inbox unificado:** Instagram + Messenger, resposta manual e takeover.
5. **IA BYOK:** OpenAI e OpenAI-compatible.
6. **Builder visual:** grafo versionado, condições, delays, ações e runtime.
7. **Operação:** observabilidade, DLQ, rate limits, auditoria e documentação Vercel/Supabase.

Cada mudança de comportamento será implementada por TDD e validada com typecheck e build de produção antes de chegar à branch principal.

## Estado do canal Messenger

Implementado e coberto por testes:

- `src/lib/facebook/oauth.ts` — Facebook Login, troca de código, token longo e listagem de Páginas;
- `src/lib/facebook/api.ts` — envio de mensagens e inscrição de webhooks;
- `src/lib/facebook/pages.ts` — persistência com token criptografado;
- `src/lib/facebook/webhook.ts` — roteamento de eventos de Página;
- `src/app/api/facebook/connect` — início do OAuth;
- `src/app/api/facebook/callback` — conclusão do OAuth e conexão das Páginas;
- `src/app/api/facebook/pages` — listagem para a interface;
- `supabase/migrations/20260914000001_messenger_channel.sql` — tabela `facebook_pages`.

Pendente, por depender de ambiente publicado e credenciais reais:

- executor do job `messenger_reply`, que envia a resposta;
- interface de seleção e desconexão de Páginas;
- validação ponta a ponta com uma Página real.

### Decisões de segurança do canal

- o token da Página trafega no corpo JSON, nunca na URL, porque URLs aparecem em logs de proxy e no cabeçalho `Referer`;
- o token nunca é devolvido à interface nem incluído no redirecionamento do OAuth;
- a identidade do usuário vem sempre do JWT de estado assinado, nunca de parâmetro de consulta;
- uma Página cuja inscrição de webhook falhou continua salva, porém sinalizada, para não descartar uma autorização já concedida;
- eventos fora da janela de 24 horas da Meta são descartados antes de virar job.
