# openfortivpn Connect

Nowe GUI dla `openfortivpn` (macOS, Ubuntu, Debian). Niezależne od starego `desktop/`.

## Uruchomienie

```bash
# wymagania: openfortivpn, perl (macOS ma go w systemie), Node.js 18+
brew install openfortivpn          # macOS
sudo apt install openfortivpn ppp  # Ubuntu / Debian

cd gui
npm install
npm start
```

Najszybszy start: **Importuj** → wklej polecenie, którym łączysz się w terminalu, np.

```
sudo openfortivpn vpn.firma.pl:443 -u jan -v -v --set-dns=0
```

GUI utworzy z niego profil, który uruchamia **dokładnie te same argumenty**
(podgląd polecenia jest na dole zakładki *Konfiguracja*).

## Jak to działa (cała ścieżka łączenia)

```
GUI (Electron, użytkownik)
 └─ sudo -S  |  pkexec            ← hasło administratora: okno GUI (sudo) lub polkit
     └─ helper/ofv-wrapper.pl (root)
         └─ openfortivpn host:port -u … --pinentry=helper/ofv-pinentry.pl …
             └─ ofv-pinentry.pl ──unix socket──► GUI: okno „Hasło” / „Kod 2FA”
```

1. **Uprawnienia** – openfortivpn musi działać jako root. Domyślnie macOS: `sudo`
   (hasło podajesz w oknie aplikacji, opcjonalnie zapamiętane w pęku kluczy),
   Linux: `pkexec` (systemowe okno polkit). Zmiana w *Ustawieniach*.
2. **Wrapper** uruchamia openfortivpn, przekazuje log do GUI i zatrzymuje go
   łagodnie (SIGTERM → przywrócenie tras) po kliknięciu *Rozłącz* — także gdy GUI
   się zamknie lub ulegnie awarii, więc tunel nigdy nie zostaje „osierocony”.
3. **Hasło i token** – openfortivpn sam pyta o sekrety przez swój mechanizm
   `--pinentry` (protokół Assuan, `src/userinput.c`). Pinentry GUI przekazuje
   pytanie do okna aplikacji z dokładnym tekstem bramy:
   - `…_password` – hasło konta (opcjonalnie z pęku kluczy / libsecret),
   - `…_2fa` – „Two-factor authentication token” (FortiToken, aplikacja TOTP),
   - `…_otp` – kod wysłany e-mailem/SMS (tekst z serwera, np. *Please enter…*).
   Sekrety nigdy nie trafiają do linii poleceń (`ps`) ani do pliku, a w logu
   są maskowane.
4. **FortiToken Mobile push** – w trybie *Automatycznie* / *Push* GUI pokazuje
   podpowiedź, by zatwierdzić logowanie na telefonie. *Zawsze wpisuj kod*
   dodaje `--no-ftm-push`.
5. **Certyfikat bramy** – gdy certyfikat nie jest zaufany, GUI pokazuje podmiot,
   wystawcę i odcisk SHA-256; po akceptacji dopisuje `--trusted-cert` do profilu
   i łączy ponownie.
6. **SAML/SSO** – `--saml-login`, strona logowania otwiera się w przeglądarce.
7. **DNS** – domyślnie `--set-dns=0` (jak w Twoim poleceniu). Opcja *Split DNS*:
   macOS – pliki `/etc/resolver/<domena>` tworzone po zestawieniu tunelu i
   usuwane po rozłączeniu; Linux – `resolvectl dns/domain` na interfejsie ppp.

Profil jest izolowany od systemowego `/etc/openfortivpn/config` (`-c /dev/null`).

## Testy

```bash
npm test     # jednostkowe + pełna ścieżka (hasło, token, OTP, certyfikat, błędy)
npm run e2e  # prawdziwe okno Electron sterowane automatycznie, ze zrzutami ekranu
```

Testy używają `test/mock-openfortivpn.js`, który mówi tym samym protokołem
pinentry co prawdziwy openfortivpn — nie potrzeba sudo ani sieci.

## Paczki

```bash
npm run dist:mac     # .dmg / .zip
npm run dist:linux   # .deb / AppImage (uruchom na Linuksie)
```

Uwaga: na woluminie FAT32/exFAT (np. `/Volumes/DANE`) macOS tworzy pliki `._*`,
które psują budowanie paczki — buduj z kopii na dysku APFS.
