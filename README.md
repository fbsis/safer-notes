# Cofre de notas

Aplicação local multiusuário para notas armazenadas em SQLite com os campos
sensíveis criptografados por usuário.

## Estrutura

`notes/notes.js` é o único ponto de entrada. As responsabilidades internas
ficam separadas:

- `application.js`: servidor HTTP e roteamento da API;
- `vault.js`: operações de usuários, notas, convites e chaves;
- `sessions.js`: sessões, CSRF, expiração e limite de tentativas;
- `crypto.js`: primitivas AES-256-GCM e `scrypt`;
- `db.js`: esquema e conexão SQLite;
- `http.js` e `validation.js`: utilitários de protocolo e validação;
- `public/`: interface executada no navegador.

## Garantias e limites

- Título e conteúdo são criptografados com AES-256-GCM antes de chegarem ao
  SQLite.
- Cada usuário possui uma chave de dados própria, protegida por uma chave
  derivada da senha com `scrypt`.
- Senhas e chaves abertas não são persistidas.
- O administrador cria convites, mas não consegue abrir cofres de outros
  usuários.
- Não existe recuperação de senha. Perder a senha significa perder
  definitivamente o conteúdo.
- A criptografia protege os dados em repouso. Um processo ou navegador
  comprometido enquanto o cofre estiver aberto ainda poderá observar o
  conteúdo.

## Execução local

Requer Node.js 24.15 ou superior:

```bash
npm ci
mkdir -p "$HOME/.secrets/notes"
openssl rand -base64 32 > "$HOME/.secrets/notes/admin-setup-token"
chmod 600 "$HOME/.secrets/notes/admin-setup-token"
NOTES_ADMIN_SETUP_TOKEN_FILE="$HOME/.secrets/notes/admin-setup-token" npm start
```

Acesse `http://127.0.0.1:3001`. O token só é necessário para criar o primeiro
administrador. Depois disso, remova-o do ambiente e reinicie a aplicação.

Variáveis disponíveis:

| Variável | Padrão | Finalidade |
| --- | --- | --- |
| `PORT` | `3001` | Porta HTTP |
| `HOST` | `127.0.0.1` | Interface de rede do processo |
| `NOTES_DB` | `data/notes.sqlite` | Caminho do SQLite |
| `NOTES_ADMIN_SETUP_TOKEN_FILE` | — | Arquivo contendo o token inicial |
| `NOTES_ADMIN_SETUP_TOKEN` | — | Alternativa local ao arquivo secreto |
| `NOTES_HTTPS` | `0` | Use `1` atrás de HTTPS para ativar cookie `Secure` |

## Docker Compose

O Compose não faz parte do projeto. Este é o modelo recomendado para uso
estritamente local:

```yaml
services:
  notes:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: notes
    volumes:
      - notes_data:/app/data
    secrets:
      - notes_admin_setup_token
    environment:
      HOST: 0.0.0.0
      PORT: 3001
      NOTES_DB: /app/data/notes.sqlite
      NOTES_ADMIN_SETUP_TOKEN_FILE: /run/secrets/notes_admin_setup_token
      NOTES_HTTPS: "0"
    ports:
      - "127.0.0.1:3001:3001"
    restart: unless-stopped

volumes:
  notes_data:

secrets:
  notes_admin_setup_token:
    file: ${NOTES_ADMIN_SETUP_TOKEN_SOURCE}
```

Gere o token fora do projeto:

```bash
mkdir -p "$HOME/.secrets/notes"
openssl rand -base64 32 > "$HOME/.secrets/notes/admin-setup-token"
chmod 600 "$HOME/.secrets/notes/admin-setup-token"
NOTES_ADMIN_SETUP_TOKEN_SOURCE="$HOME/.secrets/notes/admin-setup-token" \
  docker compose up -d
```

Após criar o primeiro administrador, retire `secrets`,
`NOTES_ADMIN_SETUP_TOKEN_FILE` e a declaração global do secret do Compose.
Recrie o container; o endpoint de configuração também fica indisponível assim
que existe um usuário.

Não substitua a publicação da porta por `3001:3001`: isso disponibilizaria o
HTTP na rede. Para uso remoto, coloque o serviço atrás de HTTPS, defina
`NOTES_HTTPS=1` e não exponha diretamente a porta do container.

## Imagens Docker

### Testes

A imagem de testes instala as dependências a partir do lockfile e executa a
suíte em um ambiente limpo:

```bash
docker build -f Dockerfile.test -t notes:test .
docker run --rm notes:test
```

Nenhum volume ou secret é necessário para os testes. O SQLite temporário é
criado dentro do container e removido ao final.

### Produção

A imagem de produção contém apenas a aplicação e as dependências necessárias,
executa como o usuário não-root `node` e possui healthcheck:

```bash
docker build -f Dockerfile -t notes:production .
docker run --rm \
  --name notes \
  -p 127.0.0.1:3001:3001 \
  -v notes_data:/app/data \
  -e NOTES_ADMIN_SETUP_TOKEN_FILE=/run/secrets/notes_admin_setup_token \
  -v "$HOME/.secrets/notes/admin-setup-token:/run/secrets/notes_admin_setup_token:ro" \
  notes:production
```

Após criar o primeiro administrador, pare o container e inicie-o novamente sem
o arquivo e sem `NOTES_ADMIN_SETUP_TOKEN_FILE`. Nunca grave o token dentro da
imagem.

## Operação

- O cofre bloqueia após 15 minutos sem requisições autenticadas, no logout ou
  sempre que o processo reinicia.
- Convites administrativos valem por 24 horas e são utilizáveis uma única vez.
- O SQLite usa WAL. Para backup consistente, pare o container antes de copiar o
  volume ou utilize uma ferramenta de backup compatível com SQLite.
- O token inicial não descriptografa notas e não substitui as senhas dos
  usuários.

## Testes

```bash
npm test
```
