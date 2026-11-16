# 72H Reset Protocol: sito, pagamento PayPal e consegna via email

Progetto pronto per Vercel. La pagina è in inglese, con il cambio lingua (inglese e italiano già pronti).
Chi compra scrive la propria email, paga sulla pagina sicura di PayPal e riceve il prodotto a quella email.

## Versione semplice: bastano 4 impostazioni

Per far partire i pagamenti servono solo queste, su Vercel:

| Nome | Valore |
| --- | --- |
| `PAYPAL_CLIENT_ID` | il Client ID di PayPal |
| `PAYPAL_CLIENT_SECRET` | il Secret di PayPal |
| `GITHUB_TOKEN` | il token di GitHub |
| `GITHUB_REPO` | la repository **privata** degli ordini (se è pubblica il sito rifiuta i pagamenti, perché contiene le email dei clienti) |

Senza `PAYPAL_ENV` il sito usa la modalità di prova (Sandbox). Per i pagamenti veri aggiungi `PAYPAL_ENV` = `live` con le chiavi Live.

Tutto il resto è facoltativo:

- Con `PRODUCT_URL` e `BONUS_URL`, dopo il pagamento il cliente trova i pulsanti per scaricare sulla pagina di ringraziamento.
- Senza, la pagina dice che i file arriveranno via email e li mandi tu a mano: l'indirizzo è nel file dell'ordine.
- Con `RESEND_API_KEY` ed `EMAIL_FROM` parte anche l'email automatica.
- `PAYPAL_WEBHOOK_ID` serve solo a completare la vendita se il cliente chiude la pagina prima di tornare sul sito.

Le sezioni qui sotto descrivono la configurazione completa.

## Come funziona un acquisto

1. Il visitatore scrive l'email e tocca il pulsante di acquisto.
2. Il server crea l'ordine su PayPal e lo salva nel database (un file per ordine in una repository GitHub privata).
3. Il visitatore approva il pagamento sulla pagina di PayPal. I dati di pagamento non passano mai dal tuo sito.
4. PayPal lo riporta sul sito. Il sito chiede conferma a PayPal, incassa, poi invia l'email con i link per scaricare.
5. Se il visitatore chiude la pagina prima di tornare, è l'avviso automatico di PayPal a far completare la vendita.

Il prezzo lo decide il server: quello che arriva dal browser viene ignorato.
Finché manca anche una sola impostazione, il sito non accetta pagamenti (mostra "Payments are not connected yet").

## Cosa c'è nella cartella

| Cartella o file | A cosa serve |
| --- | --- |
| `public/index.html` | La pagina di vendita (testi, lingue, prezzi mostrati) |
| `public/thanks.html` | La pagina di ringraziamento dopo il pagamento |
| `api/` | Le funzioni del server: pagamento, avvisi di PayPal, stato dell'ordine, download |
| `lib/` | Il codice condiviso: PayPal, database GitHub, email |
| `.env.example` | L'elenco delle impostazioni da creare su Vercel (senza valori veri) |
| `scripts/selftest.mjs` | Prova automatica dell'intero acquisto con servizi finti |

## Cosa ti serve

- **PayPal**: un'app creata su developer.paypal.com, sezione Apps & Credentials. Da lì si copiano Client ID e Secret. Per incassare pagamenti veri serve un conto PayPal Business.
- **GitHub**: due repository. Una per il sito e una **privata e separata** per gli ordini (per esempio `reset72h-orders`). Se usi la stessa, ogni ordine farebbe ripartire la pubblicazione del sito. Quando crei quella degli ordini, spunta "Add a README file".
- **Resend** (resend.com) per spedire le email, con un tuo dominio verificato. Senza dominio verificato Resend spedisce solo al tuo indirizzo.
- **Vercel** per pubblicare.
- **I file del prodotto** caricati online, con un link `https` per ciascuno.

## Chiavi di prova e chiavi vere

PayPal ha due coppie di chiavi diverse. Nella pagina Apps & Credentials c'è un interruttore in alto: **Sandbox** (prova) e **Live** (pagamenti veri).

- Se le chiavi che usi vengono da Sandbox, imposta `PAYPAL_ENV` su `sandbox`. I pagamenti sono finti e si fanno con gli account di prova che PayPal crea per te.
- Se vengono da Live, imposta `PAYPAL_ENV` su `live`. I pagamenti sono veri.

Se le chiavi e `PAYPAL_ENV` non corrispondono, PayPal rifiuta ogni richiesta.

## Pubblicare, passo per passo

1. Carica questa cartella nella repository del sito su GitHub.
2. Su Vercel: Add New, Project, scegli la repository. Framework: Other. Non serve nessun comando di build.
3. Su Vercel apri Settings, Environment Variables e crea le impostazioni della tabella qui sotto. Conviene partire con le chiavi Sandbox.
4. Collega gli avvisi di PayPal:
   - crea l'impostazione `SETUP_TOKEN` con un testo lungo a caso e ripubblica (Deployments, Redeploy);
   - apri nel browser `https://IL-TUO-SITO/api/setup-webhook?token=IL-TUO-SETUP-TOKEN`;
   - copia il valore `PAYPAL_WEBHOOK_ID` che compare e crealo come impostazione su Vercel;
   - cancella `SETUP_TOKEN` e ripubblica. Da quel momento quell'indirizzo non risponde più.
5. Fai un acquisto di prova e controlla che arrivi l'email.
6. Per i pagamenti veri: sostituisci `PAYPAL_CLIENT_ID` e `PAYPAL_CLIENT_SECRET` con le chiavi Live, imposta `PAYPAL_ENV` su `live` e ripeti il punto 4 (prova e pagamenti veri hanno avvisi separati, quindi `PAYPAL_WEBHOOK_ID` cambia).

Ogni modifica alle impostazioni vale solo dopo una nuova pubblicazione (Redeploy).

## Impostazioni su Vercel

Tutte le chiavi stanno solo qui. Nel codice e nella pagina pubblica non c'è nessun valore segreto.

| Nome | Obbligatoria | Cosa metterci |
| --- | --- | --- |
| `PAYPAL_CLIENT_ID` | sì | Il Client ID della tua app PayPal (inizia con `A`) |
| `PAYPAL_CLIENT_SECRET` | sì | Il Secret della stessa app (inizia con `E`). Non va mostrato a nessuno |
| `PAYPAL_ENV` | sì | `sandbox` per le chiavi di prova, `live` per quelle vere |
| `PAYPAL_WEBHOOK_ID` | sì | Il valore mostrato al punto 4 |
| `GITHUB_TOKEN` | sì | Token "fine-grained" con permesso "Contents: Read and write" solo sulla repository degli ordini |
| `GITHUB_REPO` | sì | `proprietario/repository`, per esempio `mario/reset72h-orders` |
| `RESEND_API_KEY` | sì | Chiave di Resend (inizia con `re_`) |
| `EMAIL_FROM` | sì | Mittente, per esempio `72H Reset Protocol <hello@tuodominio.com>` |
| `PRODUCT_URL` | sì | Link `https` di `72H-Reset-Protocol-EN.zip` |
| `BONUS_URL` | sì | Link `https` di `72H-Reset-Audio.zip` |
| `DOWNLOAD_SECRET` | sì | Testo lungo a caso, almeno 24 caratteri. Firma i link di download |
| `PRODUCT_URL_IT` | no | Link `https` di `Protocollo-Reset-72H-IT.zip`, per chi compra dalla pagina in italiano |
| `SUPPORT_EMAIL` | no | Indirizzo a cui i clienti possono rispondere |
| `SITE_URL` | no | Indirizzo del sito, per esempio `https://tuodominio.com`. Consigliata quando hai il dominio |
| `BONUS_URL_IT` | no | File audio diverso per chi compra in italiano |
| `GITHUB_BRANCH` | no | Ramo della repository degli ordini, se non è quello principale |
| `SETUP_TOKEN` | no | Serve solo durante il punto 4, poi va cancellata |
| `PRICE_CENTS`, `BUMP_CENTS` | no | Prezzi in centesimi (1490 e 490 se non le crei) |

## Cambiare testi, lingue e prezzi

- **Testi della pagina**: in `public/index.html`, nel blocco `const I18N` (un blocco per lingua).
- **Nuova lingua**: aggiungi un blocco in `I18N` copiando `en`. Poi aggiungi la stessa lingua in `public/thanks.html` (blocco `T`), in `lib/email.js` (blocco `TEXT`), in `lib/config.js` (`LANGS` e `PRODUCT`) e in `lib/paypal.js` (`LOCALE`, la lingua della pagina di PayPal). Il menu delle lingue si aggiorna da solo.
- **Prezzi**: vanno cambiati in due posti, `PRICE` in `public/index.html` (quello mostrato) e `PRICE_CENTS` / `BUMP_CENTS` su Vercel (quello incassato). Se non coincidono, il cliente paga la cifra del server.
- **Prompt gratuiti della demo**: in `I18N`, voce `term.lite`. Sono volutamente generici. I prompt completi non sono nella pagina.

## Dove trovi gli ordini

Nella repository degli ordini, cartella `orders/`: un file per ordine con email, lingua, importo e stato. Il nome del file è il numero d'ordine di PayPal.
Stati: `pending` (non pagato), `paid` (pagato, email da inviare), `delivered` (email inviata), `cancelled`, `failed`, `review` (importo o valuta diversi dal prezzo, oppure rimborsato: controllalo a mano, non viene consegnato).

## Da sapere

- Il link nell'email porta al file che hai indicato in `PRODUCT_URL`. Chi ha comprato vede quel link finale e potrebbe condividerlo: usa un link difficile da indovinare.
- Gli indirizzi email dei clienti sono dati personali. Tieni privata la repository degli ordini e pubblica una privacy policy.
- Ogni tentativo di acquisto crea un file nella repository degli ordini. Se arrivano tentativi automatici, attiva la protezione dai bot nelle impostazioni di Vercel.
- Se l'email non parte, il pagamento resta registrato e il sito riprova al prossimo avviso di PayPal. Una stessa email non viene inviata due volte e un ordine non viene incassato due volte.
- PayPal trattiene una commissione su ogni vendita: controlla le tariffe del tuo conto.

## Prova automatica

Con Node.js installato: `node scripts/selftest.mjs`. Simula acquisti, avvisi falsi, doppi invii e download usando servizi finti: nessun pagamento e nessuna email reali.
