#!/usr/bin/perl
#
# openfortivpn Connect - privileged wrapper.
#
# Runs as root (through sudo or pkexec). Starts openfortivpn as a child,
# forwards its output to stdout and stops it gracefully when the GUI writes
# "stop" on stdin or closes stdin (e.g. when the GUI crashes), so a tunnel
# is never left orphaned. Optionally configures split DNS once the tunnel is up.
#
# Usage: ofv-wrapper.pl <pinentry-socket> <dns-mode> <domains|-> <openfortivpn> [args...]
#   dns-mode: none | split
#
# Control lines written to stdout start with "OFVGUI:".
#
use strict;
use warnings;
use POSIX qw(:sys_wait_h setsid);
use IO::Handle;

STDOUT->autoflush(1);
STDERR->autoflush(1);

sub ctl { print STDOUT "OFVGUI:" . join(' ', @_) . "\n"; }

my ($socket, $dns_mode, $domains_arg, $bin, @args) = @ARGV;
if (!defined $bin) {
	ctl('ERROR', 'usage');
	exit 2;
}
if ($bin !~ m{^/} || !-x $bin) {
	ctl('ERROR', 'binary-not-executable', $bin);
	exit 2;
}
$dns_mode = 'none' unless defined $dns_mode && $dns_mode =~ /^(none|split)$/;

my @user_domains = ($domains_arg && $domains_arg ne '-')
	? grep { valid_domain($_) } split /[\s,;]+/, $domains_arg : ();

pipe(my $out_r, my $out_w) or do { ctl('ERROR', "pipe: $!"); exit 2; };

my $pid = fork();
if (!defined $pid) {
	ctl('ERROR', "fork: $!");
	exit 2;
}
if ($pid == 0) {
	close $out_r;
	setsid();
	open(STDIN, '<', '/dev/null');
	open(STDOUT, '>&', $out_w);
	open(STDERR, '>&', $out_w);
	$ENV{OFV_GUI_SOCKET} = $socket if $socket && $socket ne '-';
	$ENV{LC_ALL} = 'C';
	{ exec { $bin } $bin, @args; }
	print STDERR "ERROR:  exec $bin: $!\n";
	POSIX::_exit(127);
}
close $out_w;
ctl('PID', $pid);

my $stopping = 0;
my $stop_at = 0;
my $term_count = 0;

sub request_stop {
	return if $stopping;
	$stopping = 1;
	$stop_at = time;
	$term_count = 1;
	ctl('STOPPING');
	kill 'TERM', $pid;
}
$SIG{TERM} = $SIG{INT} = $SIG{HUP} = sub { request_stop(); };
$SIG{PIPE} = 'IGNORE';

# --- split DNS -------------------------------------------------------------
my $iface;
my @nameservers;
my @suffix_domains;
my @dns_applied;    # macOS: resolver files we created

sub valid_domain {
	my $d = shift;
	return 0 unless defined $d && length $d && length $d < 254;
	$d =~ s/^~//;
	return $d =~ /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
}

sub valid_ipv4 {
	my $ip = shift;
	return 0 unless $ip =~ /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
	return 0 if $ip eq '0.0.0.0';
	return !grep { $_ > 255 } ($1, $2, $3, $4);
}

sub dns_domains {
	my @d = @user_domains ? @user_domains : @suffix_domains;
	my %seen;
	return grep { !$seen{$_}++ } map { my $x = $_; $x =~ s/^~//; lc $x } @d;
}

sub apply_dns {
	return unless $dns_mode eq 'split';
	my @ns = grep { valid_ipv4($_) } @nameservers;
	my @domains = dns_domains();
	if (!@ns) {
		ctl('DNS', 'skipped', 'no-nameservers');
		return;
	}
	if (!@domains) {
		ctl('DNS', 'skipped', 'no-domains');
		return;
	}
	if ($^O eq 'darwin') {
		mkdir '/etc/resolver', 0755 unless -d '/etc/resolver';
		for my $d (@domains) {
			my $f = "/etc/resolver/$d";
			if (-e $f) {
				open(my $fh, '<', $f) or next;
				my $first = <$fh> // '';
				close $fh;
				if ($first !~ /openfortivpn-connect/) {
					ctl('DNS', 'kept-existing', $d);
					next;
				}
			}
			open(my $fh, '>', $f) or do { ctl('DNS', 'error', $d, $!); next; };
			print $fh "# openfortivpn-connect (removed on disconnect)\n";
			print $fh "nameserver $_\n" for @ns;
			close $fh;
			push @dns_applied, $f unless grep { $_ eq $f } @dns_applied;
		}
		system('/usr/bin/dscacheutil', '-flushcache');
		system('/usr/bin/killall', '-HUP', 'mDNSResponder');
		ctl('DNS', 'applied', join(',', @ns), join(',', @domains));
	} else {
		my ($resolvectl) = grep { -x $_ } qw(/usr/bin/resolvectl /bin/resolvectl);
		if (!$resolvectl || !$iface) {
			ctl('DNS', 'skipped', $resolvectl ? 'no-interface' : 'no-resolvectl');
			return;
		}
		my $ok = system($resolvectl, 'dns', $iface, @ns) == 0;
		$ok &&= system($resolvectl, 'domain', $iface, map { "~$_" } @domains) == 0;
		ctl('DNS', $ok ? 'applied' : 'error', join(',', @ns), join(',', @domains));
	}
}

sub cleanup_dns {
	return unless @dns_applied;
	for my $f (@dns_applied) {
		unlink $f;
	}
	@dns_applied = ();
	system('/usr/bin/dscacheutil', '-flushcache');
	system('/usr/bin/killall', '-HUP', 'mDNSResponder');
	ctl('DNS', 'removed');
}

sub parse_line {
	my $line = shift;
	$line =~ s/\e\[[0-9;]*m//g;
	if ($line =~ /Interface (\S+) is UP\./) {
		$iface = $1;
	} elsif ($line =~ /Got addresses: \[([^\]]*)\], ns \[([^\]]*)\](?:, ns_suffix \[([^\]]*)\])?/) {
		@nameservers = grep { length } split /[\s,]+/, $2;
		@suffix_domains = defined $3 ? grep { valid_domain($_) } split /[\s,;]+/, $3 : ();
	} elsif ($line =~ /Tunnel is up and running\./) {
		apply_dns();
	} elsif ($line =~ /Closed connection to gateway\.|Setting \S+ interface down\./) {
		cleanup_dns();
	}
}

# --- main loop ---------------------------------------------------------------
my $stdin_open = 1;
my $out_open = 1;
my $partial = '';
my $exit_code;

while (1) {
	my $rin = '';
	vec($rin, fileno(STDIN), 1) = 1 if $stdin_open;
	vec($rin, fileno($out_r), 1) = 1 if $out_open;
	my $n = select(my $rout = $rin, undef, undef, 0.5);

	if ($n > 0 && $out_open && vec($rout, fileno($out_r), 1)) {
		my $buf;
		my $r = sysread($out_r, $buf, 8192);
		if (!$r) {
			$out_open = 0;
		} else {
			print STDOUT $buf;
			$partial .= $buf;
			while ($partial =~ s/^([^\n]*)\n//) {
				parse_line($1);
			}
			$partial = '' if length $partial > 65536;
		}
	}
	if ($n > 0 && $stdin_open && vec($rout, fileno(STDIN), 1)) {
		my $cmd = <STDIN>;
		if (!defined $cmd) {
			$stdin_open = 0;
			request_stop();
		} elsif ($cmd =~ /^stop/) {
			request_stop();
		}
	}

	if (!defined $exit_code) {
		my $w = waitpid($pid, WNOHANG);
		if ($w == $pid) {
			$exit_code = WIFEXITED($?) ? WEXITSTATUS($?) : 128 + WTERMSIG($?);
		}
	}
	if (defined $exit_code && !$out_open) {
		last;
	}
	if (defined $exit_code && $out_open) {
		# child gone, drain remaining output quickly
		next if $n > 0;
		last;
	}

	if ($stopping && !defined $exit_code) {
		my $elapsed = time - $stop_at;
		if ($elapsed >= 10 && $term_count == 1) {
			kill 'TERM', $pid;
			$term_count = 2;
		} elsif ($elapsed >= 20) {
			kill 'KILL', $pid;
		}
	}
}

parse_line($partial) if length $partial;
cleanup_dns();
ctl('EXIT', $exit_code // 1);
exit($exit_code // 1);
