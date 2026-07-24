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

## Execução

Todo o projeto roda dentro do Docker. O host precisa apenas de Docker com
Compose; não é necessário instalar Node.js, npm, OpenSSL ou SQLite.

```bash
docker compose up -d --build
```

Acesse `http://127.0.0.1:3001`. O Compose gera automaticamente o token de
configuração dentro do volume `notes_secrets`.

Para visualizar o token no primeiro acesso:

```bash
docker compose run --rm setup cat /secrets/admin-setup-token
```

O token só cria o primeiro administrador e não descriptografa notas. Depois que
o primeiro usuário existe, o endpoint de configuração fica desativado.

Variáveis disponíveis:

| Variável | Padrão | Finalidade |
| --- | --- | --- |
| `PORT` | `3001` | Porta HTTP |
| `HOST` | `127.0.0.1` | Interface de rede do processo |
| `NOTES_DB` | `data/notes.sqlite` | Caminho do SQLite |
| `NOTES_ADMIN_SETUP_TOKEN_FILE` | — | Arquivo contendo o token inicial |
| `NOTES_ADMIN_SETUP_TOKEN` | — | Alternativa local ao arquivo secreto |
| `NOTES_HTTPS` | `0` | Use `1` atrás de HTTPS para ativar cookie `Secure` |

Para acompanhar ou encerrar:

```bash
docker compose logs -f notes
docker compose down
```

`docker compose down` preserva os volumes. Não use `down -v` em produção, pois
isso remove o banco e o token. Também não substitua a publicação da porta por
`3001:3001`: isso disponibilizaria o HTTP na rede. Para uso remoto, coloque o
serviço atrás de HTTPS, defina `NOTES_HTTPS=1` e não exponha diretamente a porta
do container.

## Imagens Docker

### Testes

A imagem de testes instala as dependências a partir do lockfile e executa a
suíte em um ambiente limpo:

```bash
docker compose -f docker-compose.test.yml run --build --rm tests
```

O Compose de testes desabilita a rede, remove capabilities, deixa o filesystem
da imagem somente para leitura e disponibiliza apenas `/tmp` em memória. Nenhum
volume persistente ou secret é usado; o SQLite temporário desaparece ao final.

Também é possível executar a imagem diretamente:

```bash
docker build -f Dockerfile.test -t notes:test .
docker run --rm --network none --read-only --tmpfs /tmp notes:test
```

### Produção

A imagem de produção contém apenas a aplicação e as dependências necessárias,
executa como o usuário não-root `node` e possui healthcheck:

```bash
docker compose up -d --build
```

## Operação

- O cofre bloqueia após 15 minutos sem requisições autenticadas, no logout ou
  sempre que o processo reinicia.
- Convites administrativos valem por 24 horas e são utilizáveis uma única vez.
- O SQLite usa WAL. Para backup consistente, pare o container antes de copiar o
  volume ou utilize uma ferramenta de backup compatível com SQLite.
- O token inicial não descriptografa notas e não substitui as senhas dos
  usuários.

Não há fluxo de execução ou testes diretamente no host; use sempre os comandos
Docker Compose documentados acima.
