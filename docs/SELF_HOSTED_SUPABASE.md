# Instalação em Supabase self-hosted (VPS / EasyPanel)

Guia para subir o sistema usando uma instância própria do Supabase, sem depender do Supabase Cloud nem da Vercel.

O código é o mesmo: o aplicativo só precisa das variáveis apontando para a sua instância.

---

## Parte 1 — Aplicar o banco

O `supabase db push` **não funciona em self-hosted**: ele exige `supabase link --project-ref`, que só existe no serviço em nuvem. Use o arquivo único já gerado.

1. Abra o **Studio** da sua instância → **SQL Editor**.
2. Abra o arquivo [`supabase/self-hosted/schema.sql`](../supabase/self-hosted/schema.sql) deste repositório.
3. Cole o conteúdo inteiro e execute **uma vez**.

O arquivo roda dentro de uma transação única. Se algo falhar, nada é aplicado — corrija a causa e cole novamente.

### Verificações automáticas

Antes de criar qualquer coisa, o arquivo confere:

- se o schema `auth` existe (o serviço GoTrue já iniciou);
- se o schema `storage` existe (o serviço Storage já iniciou);
- se o schema já foi aplicado antes.

Se aparecer erro sobre `auth` ou `storage`, inicie esses serviços uma vez e repita.

Se aparecer `Schema already applied`, o banco já está pronto — não force.

### Conferência

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
```

Devem existir, entre outras: `profiles`, `instagram_accounts`, `facebook_pages`,
`messenger_automations`, `messenger_sent_log`, `automations`, `job_queue`, `contacts`.

### Quando novas migrations forem adicionadas

O arquivo é gerado, não escrito à mão:

```bash
node scripts/build-self-hosted-schema.mjs
```

Um teste automatizado falha se o arquivo ficar dessincronizado das migrations.

---

## Parte 2 — Criar o usuário administrador

Não existe página de cadastro: o acesso é por convite.

1. Studio → **Authentication → Users → Add user**.
2. Informe e-mail e senha forte, marque **Auto Confirm User**.
3. Desative o cadastro público em **Authentication → Providers → Allow new users to sign up**.

O **primeiro perfil criado recebe automaticamente o papel `owner`**, que é quem pode configurar as credenciais da Meta. Confira:

```sql
select id, role from public.profiles order by created_at limit 5;
```

Para promover alguém depois:

```sql
update public.profiles set role = 'admin' where id = 'UUID_DO_USUARIO';
```

Essa alteração só funciona executada como superusuário do banco ou pela chave `service_role` — um usuário comum não consegue se promover.

---

## Parte 3 — Extensões do processamento em segundo plano

No SQL Editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

Sem elas, mensagens atrasadas e novas tentativas nunca são processadas.

---

## Parte 4 — Variáveis do aplicativo

| Variável | Onde obter |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL pública do Kong, com HTTPS |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave anon da sua instância |
| `SUPABASE_SERVICE_ROLE_KEY` | chave service_role da sua instância |
| `TOKEN_ENCRYPTION_KEY` | gerar, 64 caracteres hexadecimais |
| `CRON_SECRET` | gerar, texto aleatório longo |
| `NEXT_PUBLIC_APP_URL` | endereço público do aplicativo, sem barra final |

Geração das duas chaves locais:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

> `TOKEN_ENCRYPTION_KEY` protege os tokens do Instagram e das Páginas. Se for perdida ou trocada, será necessário reconectar todos os canais.

### Segurança da instância

A instalação padrão do Supabase self-hosted vem com segredos públicos, presentes no repositório oficial. **Troque todos antes de expor o serviço**:

- `POSTGRES_PASSWORD`;
- `JWT_SECRET` — e regenere `ANON_KEY` e `SERVICE_ROLE_KEY` a partir dele;
- `DASHBOARD_USERNAME` e `DASHBOARD_PASSWORD`.

Além disso:

- não exponha o Studio à internet aberta;
- use HTTPS com domínio real — o OAuth e os webhooks da Meta recusam IP puro ou certificado inválido;
- configure backup do Postgres: instalação própria não possui backup automático.

---

## Parte 5 — Publicar o aplicativo

No EasyPanel, crie um serviço apontando para este repositório.

- Build: `npm ci && npm run build`
- Start: `npm start`
- Porta: `3000`

Cadastre as variáveis da Parte 4 e publique.

> Hospedando o aplicativo na própria VPS, a restrição de uso não comercial do plano gratuito da Vercel deixa de se aplicar.

---

## Parte 6 — Agendamento do processamento

Com o aplicativo publicado, no SQL Editor — substituindo os dois valores:

```sql
select cron.schedule(
  'openreply-process-jobs',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://SEU_APP/api/cron/process-jobs',
    headers := jsonb_build_object('Authorization', 'Bearer SEU_CRON_SECRET'),
    timeout_milliseconds := 55000
  );
  $$
);
```

Conferência:

```sql
select jobname, schedule, active from cron.job;
```

---

## Parte 7 — Aplicativo da Meta

1. Entre no aplicativo com o usuário administrador.
2. Abra o **Setup Wizard** e informe o App ID e o App Secret.
3. No portal da Meta, configure o webhook com a URL e o token exibidos.
4. Cadastre as URLs de redirecionamento do OAuth:
   - `https://SEU_APP/api/instagram/callback`
   - `https://SEU_APP/api/facebook/callback`

### Instagram

Assine os campos `comments` e `messages`.

### Facebook/Messenger

Assine `messages` e `messaging_postbacks`.

Permissões necessárias:

- `pages_show_list`
- `pages_messaging`
- `pages_manage_metadata`
- `pages_read_engagement`

Em modo de desenvolvimento, apenas contas com papel no aplicativo geram eventos. Para atender o público é preciso passar pela revisão do aplicativo na Meta.

---

## Resumo da ordem

1. Subir o Supabase e iniciar `auth` e `storage`;
2. trocar todos os segredos padrão;
3. aplicar `supabase/self-hosted/schema.sql`;
4. criar o usuário administrador e desativar cadastro público;
5. criar as extensões `pg_cron` e `pg_net`;
6. publicar o aplicativo com as variáveis;
7. agendar o processamento;
8. configurar o aplicativo da Meta e conectar os canais.
