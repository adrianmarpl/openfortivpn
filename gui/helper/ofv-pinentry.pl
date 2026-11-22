#!/usr/bin/perl
#
# openfortivpn Connect - pinentry bridge.
#
# openfortivpn (started with --pinentry=<this script>) talks the Assuan
# pinentry protocol with us whenever it needs a secret: the account password,
# the server provided OTP prompt (email/SMS/FortiToken) or the 2FA token.
# Every GETPIN is relayed to the GUI over the unix socket given in
# $OFV_GUI_SOCKET and the answer is sent back to openfortivpn.
#
use strict;
use warnings;
use IO::Socket::UNIX;
use IO::Handle;

STDOUT->autoflush(1);

my %state = (prompt => '', desc => '', title => '', keyinfo => '', error => '');

sub unesc {
	my $s = shift // '';
	$s =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
	return $s;
}

sub esc {
	my $s = shift // '';
	$s =~ s/([%\r\n\t\\])/sprintf('%%%02X', ord($1))/ge;
	return $s;
}

sub ask_gui {
	my $path = $ENV{OFV_GUI_SOCKET};
	return (0, 'no GUI socket') unless $path;
	my $sock = IO::Socket::UNIX->new(Type => SOCK_STREAM(), Peer => $path)
		or return (0, "connect: $!");
	$sock->autoflush(1);
	print $sock join("\t", 'ASK', esc($state{keyinfo}), esc($state{prompt}),
		esc($state{desc}), esc($state{error})) . "\n";
	my $reply = <$sock>;
	close $sock;
	return (0, 'no reply') unless defined $reply;
	chomp $reply;
	if ($reply =~ /^PIN\t(.*)$/) {
		return (1, unesc($1));
	}
	return (0, 'cancelled');
}

print "OK openfortivpn-connect pinentry ready\n";

while (defined(my $line = <STDIN>)) {
	$line =~ s/\r?\n$//;
	my ($cmd, $arg) = split / /, $line, 2;
	$cmd = uc($cmd // '');
	$arg //= '';

	if ($cmd eq 'SETPROMPT') {
		$state{prompt} = unesc($arg);
		print "OK\n";
	} elsif ($cmd eq 'SETDESC') {
		$state{desc} = unesc($arg);
		print "OK\n";
	} elsif ($cmd eq 'SETTITLE') {
		$state{title} = unesc($arg);
		print "OK\n";
	} elsif ($cmd eq 'SETKEYINFO') {
		$state{keyinfo} = unesc($arg);
		print "OK\n";
	} elsif ($cmd eq 'SETERROR') {
		$state{error} = unesc($arg);
		print "OK\n";
	} elsif ($cmd eq 'GETPIN') {
		my ($ok, $pin) = ask_gui();
		$state{error} = '';
		if ($ok) {
			# one write: openfortivpn reads a single chunk
			print 'D ' . esc($pin) . "\nOK\n";
		} else {
			print "ERR 83886179 Operation cancelled <Pinentry>\n";
		}
	} elsif ($cmd eq 'BYE') {
		print "OK closing connection\n";
		last;
	} else {
		# OPTION, GETINFO, RESET, ... - accept everything else
		print "OK\n";
	}
}
exit 0;
