# 72H Reset Protocol: sito, pagamento PayPal e consegna via email

Progetto pronto per Vercel. La pagina è in inglese, con il cambio lingua (inglese e italiano già pronti).
Chi compra scrive la propria email, paga sulla pagina sicura di PayPal e riceve il prodotto a quella email.

## Come funziona un acquisto

1. Il visitatore scrive l'email e tocca il pulsante di acquisto.
2. Il server crea l'ordine su PayPal (`Orders v2`) e lo salva nel database (un file per ordine in una repository GitHub privata).
3. Il visitatore paga sulla pagina di PayPal (conto PayPal o carta). I dati di pagamento non passano mai dal tuo sito.
4. Quando il visitatore approva il pagamento e torna sulla pagina di ringraziamento (oppure quando PayPal invia il webhook), il server incassa (`capture`) l'ordine su PayPal, verifica l'importo e invia l'email con i link per scaricare.
5. Il visitatore vede la conferma sulla pagina di ringraziamento.

Il prezzo lo decide il server: quello che arriva dal browser viene ignorato.
Finché manca anche una sola impostazione obbligatoria, il sito non accetta pagamenti (mostra "Payments are not connected yet").

## Cosa c'è nella cartella

| Cartella o file | A cosa serve |
| --- | --- |
| `public/index.html` | La pagina di vendita (testi, lingue, prezzi mostrati) |
| `public/thanks.html` | La pagina di ringraziamento dopo il pagamento |
| `api/` | Le funzioni del server: pagamento (`/api/checkout`), webhook PayPal (`/api/paypal-webhook`), stato dell'ordine (`/api/status`), download (`/api/download`) |
| `lib/` | Il codice condiviso: PayPal (`lib/paypal.js`), configurazione (`lib/config.js`), database GitHub, email |
| `.env.example` | L'elenco delle impostazioni da creare su Vercel |
| `scripts/selftest.mjs` | Prova automatica dell'intero acquisto con servizi finti |

## Cosa ti serve

- **Conto PayPal Business** con un'app REST API creata su `https://developer.paypal.com/dashboard/` (`Client ID` e `Secret` sono già preconfigurati in `lib/config.js`, ma puoi anche sovrascriverli dalle variabili d'ambiente di Vercel).
- **GitHub**: due repository **private**. Una per il sito e una **privata e separata** per gli ordini (per esempio `reset72h-orders`). Quando crei quella degli ordini, spunta "Add a README file".
- **Resend** (resend.com) per spedire le email, con un tuo dominio verificato.
- **Vercel** per pubblicare.
- **I file del prodotto** caricati online, con un link `https` per il manuale e uno per le tracce audio.

## Impostazioni su Vercel

| Nome | Obbligatoria | Cosa metterci |
| --- | --- | --- |
| `PAYPAL_CLIENT_ID` | già preconfigurata | Client ID dell'app PayPal (se vuoi cambiarla su Vercel) |
| `PAYPAL_CLIENT_SECRET` | già preconfigurata | Secret dell'app PayPal (se vuoi cambiarla su Vercel) |
| `PAYPAL_ENV` | no | `auto` (default: rileva da solo Sandbox o Live), `sandbox` oppure `production` |
| `PAYPAL_WEBHOOK_ID` | no (consigliata) | L'ID del webhook mostrato da `/api/setup-webhook` |
| `GITHUB_TOKEN` | sì | Token "fine-grained" con permesso "Contents: Read and write" solo sulla repository degli ordini |
| `GITHUB_REPO` | sì | `proprietario/repository`, per esempio `mario/reset72h-orders` |
| `RESEND_API_KEY` | sì | Chiave di Resend (inizia con `re_`) |
| `EMAIL_FROM` | sì | Mittente, per esempio `72H Reset Protocol <hello@tuodominio.com>` |
| `PRODUCT_URL` | sì | Link `https` del manuale con il workbook |
| `BONUS_URL` | sì | Link `https` delle 5 tracce audio |
| `DOWNLOAD_SECRET` | sì | Testo lungo a caso, almeno 24 caratteri. Firma i link di download |
| `SUPPORT_EMAIL` | no | Indirizzo a cui i clienti possono rispondere |
| `SITE_URL` | no | Indirizzo del sito, per esempio `https://tuodominio.com` |
| `PRODUCT_URL_IT`, `BONUS_URL_IT` | no | File diversi per chi compra in italiano |
| `GITHUB_BRANCH` | no | Ramo della repository degli ordini, se non è quello principale |
| `SETUP_TOKEN` | no | Serve solo per lanciare `/api/setup-webhook`, poi va cancellata |
| `PRICE_CENTS`, `BUMP_CENTS` | no | Prezzi in centesimi (1490 e 490 di default) |

## Prova automatica

Con Node.js installato: `node scripts/selftest.mjs`. Simula acquisti, cattura ordine PayPal, notifiche webhook, doppi invii e download usando servizi finti.
