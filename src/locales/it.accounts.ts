/*
 * Italian translations for the accounts page, the context form and the shared
 * dialogs / menus (src/AccountsPage.tsx, src/ContextForm.tsx, src/ui.tsx).
 */
export const itAccounts: Record<string, string> = {
  // AccountsPage.tsx
  "Standard configuration": "Configurazione standard",
  "Claude subscription": "Abbonamento Claude",
  "API key": "Chiave API",
  "Accounts": "Account",
  "Add account": "Aggiungi account",
  "Name and type": "Nome e tipo",
  "Configuration": "Configurazione",
  "Status": "Stato",
  "Used in": "Uso",
  "Key in Windows Credential Manager": "Chiave in Gestione credenziali di Windows",
  "Connected": "Connesso",
  "Key missing": "Chiave mancante",
  "Sign-in required": "Accesso richiesto",
  "1 context": "1 contesto",
  "{n} contexts": "{n} contesti",
  "Sign in": "Accedi",
  "Edit": "Modifica",
  "Usage": "Consumi",
  "Sign in again": "Accedi di nuovo",
  "Delete account": "Elimina account",
  "Each account uses a separate configuration folder, so sessions don't interfere and can run at the same time.":
    "Ogni account usa una cartella di configurazione separata: le sessioni non si interferiscono e possono girare insieme.",
  "Delete this account?": "Eliminare l'account?",
  "The account {name} will be removed.": "L'account {name} verrà rimosso.",
  "Claude Code's standard configuration (~\\.claude) stays untouched.":
    "La configurazione standard di Claude Code (~\\.claude) resta intatta.",
  "Its configuration folder is also deleted (Claude Code sign-in, settings and transcripts).":
    "Viene eliminata anche la sua cartella di configurazione (accesso, impostazioni e trascrizioni di Claude Code).",
  "This context will also be deleted, along with its history. Open chats will be closed.":
    "Verranno eliminati anche questo contesto, con la loro cronologia. Le chat in corso vengono chiuse.",
  "These {n} contexts will also be deleted, along with their history. Open chats will be closed.":
    "Verranno eliminati anche questi {n} contesti, con la loro cronologia. Le chat in corso vengono chiuse.",
  "This can't be undone.": "L'operazione non si può annullare.",
  "Edit account": "Modifica account",
  "Once signed in, you can use it in one or more contexts.": "Dopo l'accesso potrai usarlo in uno o più contesti.",
  "Name": "Nome",
  "e.g. Acme client": "Es. Cliente Bianchi",
  "Color": "Colore",
  "Custom color": "Colore personalizzato",
  "Choose a custom color": "Scegli un colore personalizzato",
  "Hex color": "Colore esadecimale",
  "Preview": "Anteprima",
  "Account": "Account",
  "Type": "Tipo",
  "Claude subscription (Pro, Max, Team)": "Abbonamento Claude (Pro, Max, Team)",
  "Sign in from the browser: a tab opens running {cmd} in this account's folder.":
    "Accedi dal browser: si apre una scheda con {cmd} nella cartella di questo account.",
  "Paste the key from the Console. It's stored in Windows Credential Manager.":
    "Incolla la chiave della Console. Viene salvata in Gestione credenziali di Windows.",
  "New API key (leave empty to keep the current one)": "Nuova chiave API (lascia vuoto per non cambiarla)",
  "Each account uses a separate configuration folder.": "Ogni account usa una cartella di configurazione separata.",
  "Cancel": "Annulla",
  "Save": "Salva",
  "Continue and sign in": "Continua e accedi",
  "Add": "Aggiungi",

  // ContextForm.tsx
  "Choose the context's folders": "Scegli le cartelle del contesto",
  "Edit context": "Modifica contesto",
  "New context": "Nuovo contesto",
  "Folder changes apply from the next chat.": "Le modifiche alle cartelle valgono dalla prossima chat.",
  "Choose the folders and the account. You can change the name at any time.":
    "Scegli le cartelle e l'account. Il nome si può cambiare quando vuoi.",
  "Folders": "Cartelle",
  "Choose the working folder: Claude starts there. The others add extra context.":
    "Scegli la cartella di lavoro: Claude parte da lì. Le altre sono contesto aggiuntivo.",
  "Working folder": "Cartella di lavoro",
  "Set as working folder": "Imposta come cartella di lavoro",
  "Remove folder": "Rimuovi cartella",
  "Add folder…": "Aggiungi cartella…",
  "e.g. billing-api": "Es. fatturazione-api",
  "Suggested from the working folder": "Proposto dalla cartella di lavoro",
  "No accounts yet: add one from the Accounts page.": "Nessun account: aggiungine uno dalla pagina Account.",
  "The account can't be changed: the context's chats are saved in its profile.":
    "L'account non si può cambiare: le chat del contesto sono salvate nel suo profilo.",
  "Standard Claude Code configuration": "Configurazione standard di Claude Code",
  "Past chats for this context will be saved in {path}": "Le chat passate di questo contesto verranno salvate in {path}",
  "Create and start chat": "Crea e avvia chat",

  // ui.tsx
  "Close": "Chiudi",
  "More actions": "Altre azioni",
};
